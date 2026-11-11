// oculus-disable-file oculus/high-complexity
// oculus-disable-file oculus/high-cognitive-complexity
/**
 * oculus-rules/semantic — Type checker integration.
 *
 * Invokes type checkers directly (tsc, mypy, cargo check) and parses their
 * output into structured diagnostics. Lighter weight than LSP, no server
 * lifecycle to manage.
 *
 * ## Adding a new type checker:
 *
 * 1. Add a `TypeCheckerConfig` entry to `DEFAULT_CHECKERS`.
 * 2. Write a parser function for the output format.
 * 3. Add a case in `parseOutput()` to dispatch to your parser.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LintDiagnostic } from "../../../lint/src/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported type checker output formats. */
export type CheckerFormat = "tsc" | "mypy-json" | "cargo-json" | "pyright-json";

/** Configuration for one type checker. */
export interface TypeCheckerConfig {
  /** Unique identifier (e.g. "tsc", "mypy"). */
  name: string;
  /** Binary to invoke. */
  command: string;
  /** Arguments — $file is replaced with the actual path. */
  args: readonly string[];
  /** Output format parser. */
  format: CheckerFormat;
  /** File extensions this checker applies to. */
  extensions: readonly string[];
  /** Whether the checker is enabled by default. */
  enabled?: boolean;
}

/** A file to be type-checked. */
export interface CheckerFile {
  /** Absolute or relative file path. */
  path: string;
  /** Source content (used for stdin-based checkers). */
  content?: string;
}

// ---------------------------------------------------------------------------
// Default type checker configurations
// ---------------------------------------------------------------------------

export const DEFAULT_CHECKERS: TypeCheckerConfig[] = [
  {
    name: "tsc",
    command: "tsc",
    args: ["--noEmit", "--pretty", "false", "$file"],
    format: "tsc",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
  },
  {
    name: "mypy",
    command: "mypy",
    args: ["--no-error-summary", "--output-json", "$file"],
    format: "mypy-json",
    extensions: [".py"],
  },
  {
    name: "cargo-check",
    command: "cargo",
    args: ["check", "--message-format", "json"],
    format: "cargo-json",
    extensions: [".rs"],
  },
  {
    name: "pyright",
    command: "pyright",
    args: ["--outputjson", "$file"],
    format: "pyright-json",
    extensions: [".py", ".pyi"],
  },
];

// ---------------------------------------------------------------------------
// Binary probing
// ---------------------------------------------------------------------------

/**
 * Check if a binary is available on PATH.
 */
function isBinaryAvailable(command: string, cwd = process.cwd()): boolean {
  if (localBinary(command, cwd)) return true;

  const result = spawnSync("which", [command], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

function localBinary(command: string, cwd = process.cwd()): string | undefined {
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, "node_modules", ".bin", command);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function projectConfig(filePath: string, name = "tsconfig.json"): string | undefined {
  let dir = dirname(resolve(filePath));
  while (true) {
    const config = join(dir, name);
    if (existsSync(config)) return config;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Filter type checker configs to only those with available binaries.
 */
export function resolveAvailableCheckers(
  checkers: readonly TypeCheckerConfig[] = DEFAULT_CHECKERS,
  cwd = process.cwd(),
): TypeCheckerConfig[] {
  return checkers.filter(
    (c) => (c.enabled ?? true) && isBinaryAvailable(c.command, cwd),
  );
}

// ---------------------------------------------------------------------------
// Type checker runner
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run a type checker against a file.
 *
 * @param checker - Type checker configuration
 * @param file - File to check
 * @param timeoutMs - Timeout in milliseconds
 * @returns Parsed diagnostics (empty if checker fails or times out)
 */
export function runTypeChecker(
  checker: TypeCheckerConfig,
  file: CheckerFile,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): LintDiagnostic[] {
  // Check extension gating
  const lower = file.path.toLowerCase();
  if (
    checker.extensions.length > 0 &&
    !checker.extensions.some((ext) => lower.endsWith(ext.toLowerCase()))
  ) {
    return [];
  }

  const config = checker.format === "tsc" ? projectConfig(file.path) : undefined;
  const args = config
    ? ["--noEmit", "--pretty", "false", "--project", config]
    : checker.args.map((a) => a.replace("$file", file.path));

  const result = spawnSync(localBinary(checker.command) ?? checker.command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  // Non-zero exit is normal for type checkers (means errors found).
  // Only skip if the command itself failed (ENOTFOUND, EACCES, etc.).
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return [];
  }

  const output = result.stdout?.trim() || result.stderr?.trim() || "";
  if (!output) return [];

  return parseOutput(checker.format, file.path, output);
}

/** Run project checkers once per project and bound concurrent child processes. */
export async function runTypeCheckers(
  files: CheckerFile[],
  checkers?: readonly TypeCheckerConfig[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  failedFiles?: Set<string>,
  cwd = process.cwd(),
): Promise<Map<string, LintDiagnostic[]>> {
  const available = checkers ?? resolveAvailableCheckers(DEFAULT_CHECKERS, cwd);
  const results = new Map<string, LintDiagnostic[]>();
  if (available.length === 0) for (const file of files) failedFiles?.add(file.path);

  // Initialize result maps
  for (const f of files) {
    results.set(f.path, []);
  }

  const tasks: Array<{ files: string[]; run: () => Promise<void> }> = [];
  for (const checker of available) {
    const applicable = files.filter((f) => {
      const lower = f.path.toLowerCase();
      return checker.extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
    });

    const completedProjects = new Set<string>();
    for (const file of applicable) {
      const config = checker.format === "tsc" ? projectConfig(file.path)
        : checker.format === "cargo-json" ? projectConfig(file.path, "Cargo.toml") : undefined;
      if (checker.format === "cargo-json" && !config) continue;
      if (config) {
        if (completedProjects.has(config)) continue;
        completedProjects.add(config);
        const projectFiles = applicable.filter((f) => projectConfig(f.path,
          checker.format === "cargo-json" ? "Cargo.toml" : "tsconfig.json") === config);
        tasks.push({ files: projectFiles.map((f) => f.path), run: async () => {
          const args = checker.format === "tsc"
            ? ["--noEmit", "--pretty", "false", "--project", config]
            : [...checker.args];
          const execution = await executeChecker(checker.command, args, timeoutMs, dirname(config));
          const diags = checker.format === "tsc" ? parseTscOutput("", execution.output, dirname(config)) : [];
          const hasCargoMessages = checker.format === "cargo-json" && execution.output.split("\n").some((line) => {
            try { return JSON.parse(line).reason === "compiler-message"; } catch { return false; }
          });
          if (execution.timedOut || execution.code === null ||
              (execution.code !== 0 && diags.length === 0 && !hasCargoMessages)) {
            for (const projectFile of projectFiles) failedFiles?.add(projectFile.path);
            return;
          }
          for (const projectFile of projectFiles) {
            const matching = checker.format === "cargo-json"
              ? parseCargoJson(projectFile.path, execution.output, dirname(config))
              : diags.filter((d) => resolve(d.filePath) === resolve(projectFile.path));
            results.set(projectFile.path, [...(results.get(projectFile.path) ?? []), ...matching]);
          }
        } });
      } else {
        tasks.push({ files: [file.path], run: async () => {
          const args = checker.args.map((a) => a.replace("$file", file.path));
          const execution = await executeChecker(checker.command, args, timeoutMs, cwd);
          const diags = parseOutput(checker.format, file.path, execution.output);
          if (execution.timedOut || (execution.code !== 0 && diags.length === 0)) {
            failedFiles?.add(file.path);
            return;
          }
          results.set(file.path, [...(results.get(file.path) ?? []), ...diags]);
        } });
      }
    }
  }

  const scheduled = new Set(tasks.flatMap((task) => task.files));
  for (const file of files) if (!scheduled.has(file.path)) failedFiles?.add(file.path);

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      try { await task.run(); }
      catch { for (const file of task.files) failedFiles?.add(file); }
    }
  }));

  return results;
}

function executeChecker(command: string, args: string[], timeoutMs: number, cwd = process.cwd()): Promise<{ output: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(localBinary(command, cwd) ?? command, args, {
      cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { timedOut = true; child.kill("SIGKILL"); }
      else target.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveOutput({ output: Buffer.concat(out).toString("utf8").trim() || Buffer.concat(err).toString("utf8").trim(), code, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

/** Dispatch to the appropriate parser based on format. */
function parseOutput(
  format: CheckerFormat,
  filePath: string,
  output: string,
): LintDiagnostic[] {
  switch (format) {
    case "tsc":
      return parseTscOutput(filePath, output);
    case "mypy-json":
      return parseMypyJson(filePath, output);
    case "cargo-json":
      return parseCargoJson(filePath, output);
    case "pyright-json":
      return parsePyrightJson(filePath, output);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// tsc parser — text output
// ---------------------------------------------------------------------------

/**
 * Parse tsc text output.
 *
 * Format: `file(line,col): error TSxxxx: message`.
 */
export function parseTscOutput(filePath: string, output: string, cwd = process.cwd()): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s*(?:TS\d+:\s*)?(.*)$/i);
    if (!match) continue;
    const [, reportedPath, lineNum, colNum, severity, message] = match;
    const actualPath = resolve(cwd, reportedPath);
    if (filePath && resolve(filePath) !== actualPath) continue;
    const rule = `tsc/${severity}`;

    diagnostics.push({
      id: `tsc:${actualPath}:${lineNum}:${colNum}:${rule}`,
      filePath: actualPath,
      line: parseInt(lineNum, 10),
      column: parseInt(colNum, 10),
      severity: severity.toLowerCase() as "error" | "warning" | "info" | "hint",
      rule,
      message: message.trim(),
      source: "tsc",
      hasFix: false,
      fixCount: 0,
      blastRadius: 1,
      age: 0,
    });
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// mypy parser — JSON output
// ---------------------------------------------------------------------------

interface MypyDiagnostic {
  severity?: "error" | "warning" | "note";
  code?: string;
  line?: number;
  column?: number;
  end_line?: number;
  end_column?: number;
  message?: string;
  hostname?: string;
  times?: number[];
}

function parseMypyJson(filePath: string, output: string): LintDiagnostic[] {
  try {
    const data = JSON.parse(output) as MypyDiagnostic[];
    if (!Array.isArray(data)) return [];

    return data
      .filter((d) => d.message)
      .map((d) => ({
        id: `mypy:${filePath}:${d.line ?? 0}:${d.column ?? 0}:${d.code ?? "unknown"}`,
        filePath,
        line: d.line ?? 0,
        column: d.column ?? 0,
        severity: mapMypySeverity(d.severity),
        rule: `mypy/${d.code ?? "unknown"}`,
        message: d.message ?? "",
        source: "mypy",
        hasFix: false,
        fixCount: 0,
        blastRadius: 1,
        age: 0,
      }));
  } catch {
    return [];
  }
}

function mapMypySeverity(
  severity: string | undefined,
): "error" | "warning" | "info" | "hint" {
  switch (severity?.toLowerCase()) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "note":
      return "info";
    default:
      return "error";
  }
}

// ---------------------------------------------------------------------------
// cargo check parser — JSON output
// ---------------------------------------------------------------------------

interface CargoDiagnostic {
  message?: string;
  children?: Array<{ message?: string }>;
  level?: "error" | "warning" | "info";
  spans?: Array<{
    file_name?: string;
    line_start?: number;
    line_end?: number;
    column_start?: number;
    column_end?: number;
  }>;
  code?: { code: string; explanation?: string };
}

export function parseCargoJson(filePath: string, output: string, cwd = process.cwd()): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  // cargo check outputs one JSON object per line (NDJSON)
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let data: CargoDiagnostic;
    try {
      const raw = JSON.parse(line);
      data = raw.reason === "compiler-message" ? raw.message : raw;
    } catch {
      continue;
    }

    if (typeof data?.message !== "string") continue;

    const span = data.spans?.find((s) => s.file_name && resolve(cwd, s.file_name) === resolve(filePath));
    if (!span) continue;

    const lineNum = span?.line_start ?? 0;
    const colNum = span?.column_start ?? 0;
    const rule = `rustc/${data.code?.code ?? "unknown"}`;

    diagnostics.push({
      id: `cargo-check:${filePath}:${lineNum}:${colNum}:${rule}`,
      filePath,
      line: lineNum,
      column: colNum,
      severity: mapCargoSeverity(data.level),
      rule,
      message: data.message.trim(),
      source: "cargo-check",
      hasFix: false,
      fixCount: 0,
      blastRadius: 1,
      age: 0,
    });
  }

  return diagnostics;
}

function mapCargoSeverity(
  level: string | undefined,
): "error" | "warning" | "info" | "hint" {
  switch (level?.toLowerCase()) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
    default:
      return "warning";
  }
}

// ---------------------------------------------------------------------------
// pyright parser — JSON output
// ---------------------------------------------------------------------------

interface PyrightResult {
  generalDiagnostics?: Array<{
    message?: string;
    rule?: string;
    severity?: "error" | "warning" | "information" | "message";
    range?: {
      start?: { line?: number; character?: number };
      end?: { line?: number; character?: number };
    };
  }>;
}

function parsePyrightJson(filePath: string, output: string): LintDiagnostic[] {
  try {
    const data = JSON.parse(output) as PyrightResult;
    const diags = data.generalDiagnostics ?? [];

    return diags
      .filter((d) => d.message)
      .map((d) => ({
        id: `pyright:${filePath}:${d.range?.start?.line ?? 0}:${d.range?.start?.character ?? 0}:${d.rule ?? "unknown"}`,
        filePath,
        line: d.range?.start?.line ?? 0,
        column: d.range?.start?.character ?? 0,
        severity: mapPyrightSeverity(d.severity),
        rule: `pyright/${d.rule ?? "unknown"}`,
        message: d.message ?? "",
        source: "pyright",
        hasFix: false,
        fixCount: 0,
        blastRadius: 1,
        age: 0,
      }));
  } catch {
    return [];
  }
}

function mapPyrightSeverity(
  severity: string | undefined,
): "error" | "warning" | "info" | "hint" {
  switch (severity?.toLowerCase()) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "information":
      return "info";
    case "message":
      return "hint";
    default:
      return "warning";
  }
}

// ---------------------------------------------------------------------------
// Public convenience
// ---------------------------------------------------------------------------

/**
 * Run all available type checkers against a set of files.
 *
 * This is the main entry point for semantic type checking.
 * Auto-discovers available type checkers and runs them against applicable files.
 *
 * @param files - Files to check
 * @param timeoutMs - Per-checker timeout (default: 30000ms)
 * @returns Map from file path to diagnostics
 */
export async function runSemanticAnalysis(
  files: CheckerFile[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  failedFiles?: Set<string>,
  cwd = process.cwd(),
): Promise<Map<string, LintDiagnostic[]>> {
  return runTypeCheckers(files, undefined, timeoutMs, failedFiles, cwd);
}

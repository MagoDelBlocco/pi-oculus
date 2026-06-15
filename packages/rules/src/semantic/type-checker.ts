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

import { spawnSync } from "node:child_process";
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
    command: "npx",
    args: ["tsc", "--noEmit", "--pretty", "--stdin", "--stdinStripComments"],
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
    command: "npx",
    args: ["pyright", "--outputjson", "--files", "$file"],
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
function isBinaryAvailable(command: string): boolean {
  // For npx-based commands, always assume available (npx is part of npm).
  if (command === "npx") return true;

  const result = spawnSync("which", [command], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

/**
 * Filter type checker configs to only those with available binaries.
 */
export function resolveAvailableCheckers(
  checkers: readonly TypeCheckerConfig[] = DEFAULT_CHECKERS,
): TypeCheckerConfig[] {
  return checkers.filter(
    (c) => (c.enabled ?? true) && isBinaryAvailable(c.command),
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

  const args = checker.args.map((a) => a.replace("$file", file.path));

  const result = spawnSync(checker.command, args, {
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

/**
 * Run type checkers against multiple files.
 *
 * Files are checked sequentially per checker (type checkers need project context).
 * Checkers run in parallel.
 *
 * @param files - Files to check
 * @param checkers - Type checker configs (defaults to auto-discovered)
 * @param timeoutMs - Per-checker timeout
 * @returns Map from file path to diagnostics
 */
export async function runTypeCheckers(
  files: CheckerFile[],
  checkers?: readonly TypeCheckerConfig[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Map<string, LintDiagnostic[]>> {
  const available = checkers ?? resolveAvailableCheckers();
  const results = new Map<string, LintDiagnostic[]>();

  // Initialize result maps
  for (const f of files) {
    results.set(f.path, []);
  }

  // Run each checker against applicable files
  for (const checker of available) {
    const applicable = files.filter((f) => {
      const lower = f.path.toLowerCase();
      return checker.extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
    });

    for (const file of applicable) {
      try {
        const diags = runTypeChecker(checker, file, timeoutMs);
        const existing = results.get(file.path) ?? [];
        results.set(file.path, [...existing, ...diags]);
      } catch {
        // Skip on error — type checker may crash on malformed files.
      }
    }
  }

  return results;
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
 * Format: `file:line:col - error TSxxxx: message`
 * Example: `src/index.ts:10:5 - error TS2322: Type 'string' is not assignable to type 'number'.`
 */
function parseTscOutput(filePath: string, output: string): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // Match: file:line:col - error|warning TSxxxx: message
    const match = line.match(
      /(?:(.+?):)?(\d+):(\d+)\s*-\s*(error|warning)\s*(?:TS\d+:\s*)?(.*)/i,
    );
    if (!match) continue;

    const [, , lineNum, colNum, severity, message] = match;
    const rule = `tsc/${severity}`;

    diagnostics.push({
      id: `tsc:${filePath}:${lineNum}:${colNum}:${rule}`,
      filePath,
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

function parseCargoJson(filePath: string, output: string): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  // cargo check outputs one JSON object per line (NDJSON)
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let data: CargoDiagnostic;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }

    if (!data.message) continue;

    // Skip non-file diagnostics (compiler messages, etc.)
    const span = data.spans?.[0];
    if (span?.file_name && !span.file_name.includes(filePath.split("/").pop() ?? "")) {
      continue;
    }

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
): Promise<Map<string, LintDiagnostic[]>> {
  return runTypeCheckers(files, undefined, timeoutMs);
}

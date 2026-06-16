// oculus-disable-file oculus/high-complexity
// oculus-disable-file oculus/high-cognitive-complexity
/**
 * oculus-rules/semantic/semgrep — semgrep integration.
 *
 * Runs semgrep as a subprocess and parses its JSON output into structured
 * diagnostics. semgrep is a powerful pattern-matching static analyzer that
 * supports multiple languages and a rich rule ecosystem.
 *
 * ## Usage:
 *
 *   - `--config=auto` enables semgrep's community rules (excellent defaults)
 *   - Custom rules can be added via the `rules` option in `.pi/oculus.json`
 *   - Output is parsed from JSON format (`--json`)
 *
 * NOTE: Complexity is structural — multiple entry points + argument building
 * + JSON parsing. Suppression is intentional.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LintDiagnostic } from "../../../lint/src/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for semgrep integration. */
export interface SemgrepConfig {
  /** Whether semgrep is enabled. */
  enabled?: boolean;
  /** Additional semgrep arguments (e.g. ["--config=p/rule-slugs"]). */
  args?: readonly string[];
  /** Path to a custom rules directory or YAML file. */
  rules?: string;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** File extensions to scan (empty = all). */
  extensions?: readonly string[];
}

/** semgrep JSON output structure. */
interface SemgrepOutput {
  results?: SemgrepResult[];
  errors?: unknown[];
  version?: string;
}

interface SemgrepResult {
  check_id?: string;
  message?: string;
  severity?: "ERROR" | "WARNING" | "INFO" | "UNKNOWN";
  extra?: {
    message?: string;
    metadata?: Record<string, unknown>;
  };
  path?: string;
  start?: {
    line?: number;
    col?: number;
    offset?: number;
  };
  end?: {
    line?: number;
    col?: number;
    offset?: number;
  };
  fingerprint?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000; // semgrep can be slow on large codebases

/** Default semgrep configuration. */
export const DEFAULT_SEMGREP_CONFIG: SemgrepConfig = {
  enabled: true,
  args: ["--config=auto", "--json", "--quiet"],
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

/**
 * Load semgrep configuration from `.pi/oculus.json` (the `semgrep` key),
 * merged over the defaults. Returns the defaults when the file is missing,
 * unparseable, or has no `semgrep` section.
 *
 * Example `.pi/oculus.json`:
 * ```json
 * { "semgrep": { "enabled": true, "rules": "p/security-audit" } }
 * ```
 */
export function loadSemgrepConfig(cwd: string = process.cwd()): SemgrepConfig {
  try {
    const raw = readFileSync(resolve(cwd, ".pi/oculus.json"), "utf8");
    const parsed = JSON.parse(raw) as { semgrep?: SemgrepConfig };
    if (parsed && typeof parsed.semgrep === "object" && parsed.semgrep) {
      return { ...DEFAULT_SEMGREP_CONFIG, ...parsed.semgrep };
    }
  } catch {
    // Missing/invalid config — fall back to defaults. Intentional no-op.
  }
  return DEFAULT_SEMGREP_CONFIG;
}

// ---------------------------------------------------------------------------
// Binary probing
// ---------------------------------------------------------------------------

/**
 * Check if semgrep is available on PATH.
 */
export function isSemgrepAvailable(): boolean {
  const result = spawnSync("which", ["semgrep"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run semgrep against a set of files.
 *
 * @param files - Files to scan (paths only — semgrep reads from disk)
 * @param config - semgrep configuration
 * @returns Parsed diagnostics
 */
export function runSemgrep(
  files: readonly string[],
  config: SemgrepConfig = DEFAULT_SEMGREP_CONFIG,
): LintDiagnostic[] {
  if (!isSemgrepAvailable()) return [];
  if (files.length === 0) return [];

  const args = buildSemgrepArgs(config, files);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = spawnSync("semgrep", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  // Non-zero exit is normal for semgrep (means findings were detected).
  // Exit code 1 = findings, 2 = error, 124 = timeout, 130 = cancelled.
  if (result.status === 2 || result.status === null) {
    // Actual error or killed — return what we have.
  }

  const output = result.stdout?.trim() || "";
  if (!output) return [];

  return parseSemgrepJson(output);
}

/**
 * Run semgrep against a directory.
 *
 * @param dir - Directory to scan
 * @param config - semgrep configuration
 * @returns Parsed diagnostics
 */
export function runSemgrepOnDir(
  dir: string,
  config: SemgrepConfig = DEFAULT_SEMGREP_CONFIG,
): LintDiagnostic[] {
  if (!isSemgrepAvailable()) return [];

  const args = buildSemgrepArgs(config, [dir]);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = spawnSync("semgrep", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const output = result.stdout?.trim() || "";
  if (!output) return [];

  return parseSemgrepJson(output);
}

// ---------------------------------------------------------------------------
// Argument building
// ---------------------------------------------------------------------------

function buildSemgrepArgs(
  config: SemgrepConfig,
  targets: readonly string[],
): string[] {
  const args: string[] = [];

  // Base args from config
  if (config.args) {
    args.push(...config.args);
  } else {
    args.push("--config=auto", "--json", "--quiet");
  }

  // Custom rules
  if (config.rules) {
    args.push("--config", config.rules);
  }

  // Extension filtering
  if (config.extensions && config.extensions.length > 0) {
    args.push("--include", config.extensions.join("|"));
  }

  // Targets (files or directories)
  args.push(...targets);

  return args;
}

// ---------------------------------------------------------------------------
// JSON parser
// ---------------------------------------------------------------------------

/**
 * Parse semgrep JSON output into structured diagnostics.
 */
function parseSemgrepJson(output: string): LintDiagnostic[] {
  let data: SemgrepOutput;
  try {
    data = JSON.parse(output);
  } catch {
    return [];
  }

  const results = data.results ?? [];
  const diagnostics: LintDiagnostic[] = [];

  for (const result of results) {
    const filePath = result.path ?? "";
    const line = result.start?.line ?? 0;
    const column = result.start?.col ?? 0;
    const ruleId = result.check_id ?? "semgrep/unknown";
    const message = result.extra?.message ?? result.message ?? "";
    const severity = mapSemgrepSeverity(result.severity);

    diagnostics.push({
      id: `semgrep:${filePath}:${line}:${column}:${ruleId}`,
      filePath,
      line,
      column,
      severity,
      rule: ruleId,
      message,
      source: "semgrep",
      hasFix: false,
      fixCount: 0,
      blastRadius: 1,
      age: 0,
    });
  }

  return diagnostics;
}

/**
 * Map semgrep severity to oculus severity.
 */
function mapSemgrepSeverity(
  severity: string | undefined,
): "error" | "warning" | "info" | "hint" {
  switch (severity?.toUpperCase()) {
    case "ERROR":
      return "error";
    case "WARNING":
      return "warning";
    case "INFO":
      return "info";
    case "UNKNOWN":
    default:
      return "warning";
  }
}

// ---------------------------------------------------------------------------
// Public convenience
// ---------------------------------------------------------------------------

/**
 * Run semgrep as part of the semantic analysis pipeline.
 *
 * This is the entry point used by `runSemanticAnalysis()`.
 * Returns diagnostics for files that semgrep can analyze.
 *
 * @param files - Files to scan
 * @param config - semgrep configuration
 * @returns Parsed diagnostics
 */
export function runSemgrepAnalysis(
  files: Array<{ path: string; content?: string }>,
  config: SemgrepConfig = DEFAULT_SEMGREP_CONFIG,
): LintDiagnostic[] {
  if (!config.enabled) return [];
  const paths = files.map((f) => f.path);
  return runSemgrep(paths, config);
}

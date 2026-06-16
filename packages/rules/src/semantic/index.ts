/**
 * oculus-rules/semantic — Semantic analysis entry point.
 *
 * Re-exports type checker and semgrep integration for semantic (type-aware)
 * diagnostics. These run at `turn_end` alongside linters.
 *
 * `runSemanticDiagnostics()` is the combined entry point: it runs the type
 * checkers AND semgrep, merging both into a single per-file diagnostic map.
 * Use it from the engine pipeline. `runSemanticAnalysis()` remains type-checker
 * only, for callers that want to compose semgrep separately.
 */

import { runSemanticAnalysis, type CheckerFile } from "./type-checker";
import {
  runSemgrepAnalysis,
  loadSemgrepConfig,
  type SemgrepConfig,
} from "./semgrep";
import type { LintDiagnostic } from "../../../lint/src/index";

export {
  runTypeChecker,
  runTypeCheckers,
  runSemanticAnalysis,
  resolveAvailableCheckers,
  DEFAULT_CHECKERS,
} from "./type-checker";

export type {
  TypeCheckerConfig,
  CheckerFile,
  CheckerFormat,
} from "./type-checker";

export {
  runSemgrep,
  runSemgrepOnDir,
  runSemgrepAnalysis,
  isSemgrepAvailable,
  loadSemgrepConfig,
  DEFAULT_SEMGREP_CONFIG,
} from "./semgrep";

export type { SemgrepConfig } from "./semgrep";

/** Options for {@link runSemanticDiagnostics}. */
export interface SemanticOptions {
  /** Per-type-checker timeout in milliseconds. */
  timeoutMs?: number;
  /** semgrep config; defaults to `.pi/oculus.json` (the `semgrep` key). */
  semgrep?: SemgrepConfig;
}

/**
 * Run the full semantic layer — type checkers + semgrep — and merge the
 * results into one map keyed by file path.
 *
 * semgrep is gated by `isSemgrepAvailable()` inside `runSemgrepAnalysis`, so
 * this is a clean no-op (type checkers only) when semgrep isn't installed.
 *
 * @param files - Files to analyze (path + content).
 * @param options - Optional timeout / semgrep config overrides.
 * @returns Map from file path to its semantic diagnostics.
 */
export async function runSemanticDiagnostics(
  files: CheckerFile[],
  options: SemanticOptions = {},
): Promise<Map<string, LintDiagnostic[]>> {
  const results = await runSemanticAnalysis(files, options.timeoutMs);
  if (files.length === 0) return results;

  const semgrepConfig = options.semgrep ?? loadSemgrepConfig();
  const semgrepDiags = runSemgrepAnalysis(
    files.map((f) => ({ path: f.path })),
    semgrepConfig,
  );
  if (semgrepDiags.length === 0) return results;

  // Merge semgrep findings into the per-file map. semgrep echoes the path it
  // was given; match it back to an input path, else key under the reported one.
  const inputPaths = new Set(files.map((f) => f.path));
  for (const diag of semgrepDiags) {
    const key = inputPaths.has(diag.filePath)
      ? diag.filePath
      : matchByBasename(diag.filePath, files) ?? diag.filePath;
    const existing = results.get(key) ?? [];
    existing.push({ ...diag, filePath: key });
    results.set(key, existing);
  }

  return results;
}

/** Best-effort match of a semgrep-reported path to an input file by basename. */
function matchByBasename(
  reported: string,
  files: CheckerFile[],
): string | undefined {
  const base = reported.split("/").pop();
  if (!base) return undefined;
  const hit = files.find((f) => f.path.split("/").pop() === base);
  return hit?.path;
}

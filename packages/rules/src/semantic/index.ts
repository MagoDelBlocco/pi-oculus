/**
 * oculus-rules/semantic — Semantic analysis entry point.
 *
 * Re-exports type checker and semgrep integration for semantic (type-aware)
 * diagnostics. These run at `turn_end` alongside linters.
 */

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
  DEFAULT_SEMGREP_CONFIG,
} from "./semgrep";

export type { SemgrepConfig } from "./semgrep";

/**
 * Shared types for oculus-rules.
 *
 * `Severity` is the canonical severity type used across all packages.
 * `RuleMatch` is the output of the rules engine — one match per finding,
 * produced either by the native pattern scanner or by threshold-based
 * fact rules in TypeScript.
 */

/**
 * Severity levels in descending priority.
 *
 * Drives sort order in the report, visual weight in the status bar,
 * and base weight in the scoring algorithm.
 */
export type Severity = "error" | "warning" | "info" | "hint";

/**
 * A single rule match from the rules engine.
 *
 * Produced by `runRulesFromMetrics()` which combines:
 * - Pattern hits from the native C++ scanner (eval, debugger, etc.)
 * - Threshold-based fact rules (complexity, nesting, entropy)
 *
 * Each match is converted to a `DiagnosticRecord` by the core engine
 * and stored in `state.diagnostics`.
 */
export interface RuleMatch {
	/** Stable unique identifier (e.g. "oculus/debugger-statement:file.ts:5:3"). */
	id: string;
	/** Canonical rule id without file/line (e.g. "oculus/debugger-statement"). */
	ruleId: string;
	/** Same as ruleId — kept for backward compatibility. */
	rule: string;
	/** Human-readable description shown in the report. */
	message: string;
	/** Severity bucket — drives report sort order and visual weight. */
	severity: Severity;
	/** Absolute or relative file path. */
	filePath: string;
	/** 1-indexed line number. 0 for file-level diagnostics. */
	line: number;
	/** 1-indexed column number. 0 for file-level diagnostics. */
	column: number;
	/** Code snippet from the matched line, for inline display. */
	snippet?: string;
	/** Optional one-line remediation hint shown as "Fix: ..." in the report. */
	fix?: string;
}

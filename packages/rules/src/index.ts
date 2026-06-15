/**
 * oculus-rules — Maps native pattern detections to rule metadata and adds
 * threshold-based fact rules.
 *
 * Two categories of rules:
 *
 * 1. **Pattern rules** — detected by the C++ single-pass scanner
 *    (packages/native/pattern_detect.cpp). Each pattern id (e.g. "eval",
 *    "debugger") is mapped here to a RuleSpec with message, severity, and
 *    fix hint. The scanner returns PatternHit[] which are converted to
 *    RuleMatch[] using this metadata.
 *
 * 2. **Fact rules** — derived from FileMetrics thresholds computed by the
 *    native addon. High cyclomatic complexity, high cognitive complexity,
 *    deep nesting, and high entropy are checked here against configurable
 *    thresholds.
 *
 * ## Adding a new pattern rule:
 *
 * 1. Add a scanner to `packages/native/pattern_detect.cpp` that emits a
 *    stable pattern id (e.g. "sql-concat").
 * 2. Add an entry to `PATTERN_RULES` below mapping the id to RuleSpec.
 * 3. Rebuild the native addon: `cd packages/native && npx node-gyp rebuild`
 * 4. Add a test in `packages/rules/test/facts.test.ts`.
 *
 * ## Adding a new fact rule:
 *
 * Add threshold logic to `runRulesFromMetrics()` below, or add a custom
 * check in `packages/core/src/analyze.ts` for rules that need more than
 * simple threshold comparison.
 */

import { analyzeFile } from "../../native/src/native-bridge";
import type {
	FileMetrics,
	PatternHit,
} from "../../native/src/native-bridge";
import type { RuleMatch, Severity } from "./types";

export type { RuleMatch, Severity } from "./types";
export type { FileMetrics } from "../../native/src/native-bridge";

/**
 * Rule metadata for one pattern rule.
 *
 * Bridges the C++ pattern id (e.g. "eval") to the TypeScript rule system
 * with a human-readable message, severity, and fix hint.
 */
interface RuleSpec {
	rule: string;        // canonical rule id, e.g. "oculus/eval-detected"
	message: string;     // shown in the report as the issue description
	severity: Severity;  // drives sort order and visual weight
	fix: string;         // one-line remediation hint shown inline in the report
}

/**
 * Mapping from C++ pattern ids to rule metadata.
 *
 * Keys must match the pattern ids emitted by pattern_detect.cpp.
 * When the scanner finds a match, the pattern id is looked up here to
 * produce a RuleMatch with full metadata.
 */
const PATTERN_RULES: Record<string, RuleSpec> = {
	eval: {
		rule: "oculus/eval-detected",
		message: "Avoid eval()",
		severity: "error",
		fix: "use a safer parser (JSON.parse, Function constructor with explicit args) or drop the dynamic path.",
	},
	debugger: {
		rule: "oculus/debugger-statement",
		message: "Debugger statement",
		severity: "warning",
		fix: "delete this line.",
	},
	"console-log": {
		rule: "oculus/console-log",
		message: "console.* in production",
		severity: "info",
		fix: "remove or guard with a debug flag (e.g. `if (DEBUG) console.log(...)`).",
	},
	"empty-catch": {
		rule: "oculus/error-swallowing",
		message: "Empty catch block",
		severity: "warning",
		fix: "log the error, rethrow, or add a comment explaining the intentional swallow.",
	},
	"hardcoded-secret": {
		rule: "oculus/hardcoded-secret",
		message: "Hardcoded credential",
		severity: "error",
		fix: "move to an env var; never commit secrets to source.",
	},
	alert: {
		rule: "oculus/no-alert",
		message: "alert() in production",
		severity: "warning",
		fix: "use a proper UI affordance (toast, modal) instead of alert().",
	},
};

/**
 * Configurable complexity thresholds.
 *
 * Each metric has a warning and error threshold. When a file's metric
 * exceeds the warning threshold, a warning diagnostic is emitted.
 * When it exceeds the error threshold, an error diagnostic is emitted
 * (not both — error subsumes warning).
 */
export interface ComplexityThresholds {
	/** Cyclomatic complexity warning threshold (default: 15). */
	cyclomatic: number;
	/** Cognitive complexity warning threshold (default: 25). */
	cognitive: number;
	/** Cyclomatic complexity error threshold (default: 40). */
	cyclomaticError: number;
	/** Cognitive complexity error threshold (default: 50). */
	cognitiveError: number;
}

/** Default thresholds — tuned for general-purpose codebases. */
const DEFAULT_THRESHOLDS: ComplexityThresholds = {
	cyclomatic: 15,
	cognitive: 25,
	cyclomaticError: 40,
	cognitiveError: 50,
};

/** Convert a native PatternHit into a fully-typed RuleMatch using spec metadata. */
function makeMatch(filePath: string, hit: PatternHit, spec: RuleSpec): RuleMatch {
	return {
		id: `${spec.rule}:${filePath}:${hit.line}:${hit.column}`,
		ruleId: spec.rule,
		rule: spec.rule,
		message: spec.message,
		severity: spec.severity,
		filePath,
		line: hit.line,
		column: hit.column,
		snippet: hit.snippet,
		fix: spec.fix,
	};
}

/** Create a file-level RuleMatch (line=0, column=0) for threshold-based rules. */
function makeFactMatch(
	filePath: string,
	rule: string,
	message: string,
	severity: Severity,
): RuleMatch {
	return {
		id: `${rule}:${filePath}`,
		ruleId: rule,
		rule,
		message,
		severity,
		filePath,
		line: 0,
		column: 0,
	};
}

/**
 * Derive rule matches from a pre-computed `FileMetrics` blob.
 *
 * Combines two sources:
 * 1. Pattern hits from the native scanner (eval, debugger, console.log, etc.)
 * 2. Threshold-based fact rules (complexity, cognitive complexity)
 *
 * Use this when the caller already has metrics (e.g. `analyzeChangedFiles`)
 * to avoid a redundant native call. For standalone use, prefer `runRules()`.
 *
 * @param filePath - File path for diagnostic attribution
 * @param metrics - Pre-computed metrics from `analyzeFile()`
 * @param thresholds - Optional custom thresholds (defaults to DEFAULT_THRESHOLDS)
 * @returns Array of rule matches (may be empty)
 */
export function runRulesFromMetrics(
	filePath: string,
	metrics: FileMetrics,
	thresholds: ComplexityThresholds = DEFAULT_THRESHOLDS,
): RuleMatch[] {
	const matches: RuleMatch[] = [];

	// Pattern rules: map each native hit to a RuleMatch via PATTERN_RULES.
	for (const hit of metrics.patterns) {
		const spec = PATTERN_RULES[hit.pattern];
		if (spec) matches.push(makeMatch(filePath, hit, spec));
	}

	// Fact rules: check cyclomatic complexity against thresholds.
	if (metrics.cyclomatic > thresholds.cyclomaticError) {
		matches.push(
			makeFactMatch(
				filePath,
				"oculus/high-complexity",
				`Cyclomatic complexity ${metrics.cyclomatic} exceeds error threshold ${thresholds.cyclomaticError}`,
				"error",
			),
		);
	} else if (metrics.cyclomatic > thresholds.cyclomatic) {
		matches.push(
			makeFactMatch(
				filePath,
				"oculus/high-complexity",
				`Cyclomatic complexity ${metrics.cyclomatic} exceeds warning threshold ${thresholds.cyclomatic}`,
				"warning",
			),
		);
	}

	// Fact rules: check cognitive complexity against thresholds.
	if (metrics.cognitive > thresholds.cognitiveError) {
		matches.push(
			makeFactMatch(
				filePath,
				"oculus/high-cognitive-complexity",
				`Cognitive complexity ${metrics.cognitive} exceeds error threshold ${thresholds.cognitiveError}`,
				"error",
			),
		);
	} else if (metrics.cognitive > thresholds.cognitive) {
		matches.push(
			makeFactMatch(
				filePath,
				"oculus/high-cognitive-complexity",
				`Cognitive complexity ${metrics.cognitive} exceeds warning threshold ${thresholds.cognitive}`,
				"warning",
			),
		);
	}

	return matches;
}

/**
 * Convenience wrapper: runs `analyzeFile()` then `runRulesFromMetrics()`.
 *
 * Use this for standalone rule checking when you don't already have metrics.
 * For batch analysis (e.g. in the main pipeline), call `analyzeFile()` once
 * and pass the result to `runRulesFromMetrics()` to avoid redundant work.
 */
export function runRules(
	filePath: string,
	content: string,
	thresholds: ComplexityThresholds = DEFAULT_THRESHOLDS,
): RuleMatch[] {
	return runRulesFromMetrics(filePath, analyzeFile(content), thresholds);
}

/**
 * Async alias for `runRules()`. Kept for API compatibility with linter
 * runners that expect an async interface.
 */
export async function runAllRules(
	filePath: string,
	content: string,
): Promise<RuleMatch[]> {
	return runRules(filePath, content);
}

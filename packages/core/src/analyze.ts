import { analyzeFile } from "../../native/src/native-bridge";
import type { FileMetrics } from "../../native/src/native-bridge";
import { runRulesFromMetrics } from "../../rules/src/index";
import type { RuleMatch } from "../../rules/src/types";
import type { EngineState } from "./state";
import type { DiagnosticRecord } from "./types";
import type { ReadFile } from "./io";
import { changedLines } from "./diff";
import { parseSuppressions, isSuppressed } from "./suppression";
import { shouldSkipAnalysis, shouldSkipByPath } from "./guard";

const ENTROPY_THRESHOLD = 6.5;
const NESTING_THRESHOLD = 6;
const NESTING_ERROR_THRESHOLD = 10;
/**
 * Sources owned by the per-edit native analysis pass. Resolution here is scoped
 * to these so it never clobbers AST (`oculus-ast`) or semantic
 * (`oculus-semantic`) diagnostics — those are owned by the turn_end passes and
 * resolve themselves. A broad `oculus-` prefix would wrongly resolve them on
 * every edit, since this pass never re-emits their ids.
 */
const ANALYZE_OWNED_SOURCES = new Set(["oculus-native", "oculus-rules"]);

/**
 * Analyze every changed file with diff awareness:
 *   - For each file, fetch the pre-edit snapshot (taken in `tool_call`).
 *   - Compute pre + post metrics in two native calls.
 *   - Report only rule matches whose line text is new in the post-edit content,
 *     and file-level diagnostics whose threshold wasn't already breached pre-edit.
 *   - Track the per-file touched line range so scoring's proximity term has
 *     real data instead of falling back to a 50-point neutral guess.
 *   - Resolve previously-emitted oculus diagnostics for this file that no
 *     longer appear in the post-edit analysis.
 */
export async function analyzeChangedFiles(
	state: EngineState,
	readFile: ReadFile,
): Promise<void> {
	state.preExistingIssues.clear();
	for (const filePath of state.changedFiles) {
		if (shouldSkipByPath(filePath)) continue;
		let after: string;
		try {
			after = await readFile(filePath);
		} catch {
			after = "";
		}
		if (!after) {
			// File disappeared — nothing to analyze, but still run resolution
			// against an empty match set.
			resolveDisappeared(state, filePath, new Set());
			continue;
		}
		if (shouldSkipAnalysis(after)) continue;

		const before = state.fileSnapshots.get(filePath) ?? "";
		const beforeMetrics = state.fileSnapshotMetrics.get(filePath) ??
			(before ? analyzeFile(before) : null);
		const afterMetrics = analyzeFile(after);

		const changed = changedLines(before, after);
		if (changed.size > 0) state.touchedLines.set(filePath, changed);

		const preExistingCount = countPreExistingLineTagged(
			filePath,
			after,
			afterMetrics,
			before,
			changed,
		);
		state.preExistingIssues.set(filePath, preExistingCount);

		const suppressions = parseSuppressions(after);
		const newRecords = collectNewRecords(
			filePath,
			before,
			after,
			beforeMetrics,
			afterMetrics,
			changed,
		).filter(
			(rec) =>
				!isSuppressed(
					suppressions,
					rec.diagnostic.line,
					rec.diagnostic.rule,
				),
		);

		const currentIds = new Set<string>();
		for (const rec of newRecords) {
			currentIds.add(rec.id);
			state.upsertDiagnostic(rec);
		}

		resolveDisappeared(state, filePath, currentIds);
	}
}

function collectNewRecords(
	filePath: string,
	before: string,
	after: string,
	beforeMetrics: FileMetrics | null,
	afterMetrics: FileMetrics,
	changed: Set<number>,
): DiagnosticRecord[] {
	const now = Date.now();
	const records: DiagnosticRecord[] = [];
	const afterLines = after.split("\n");
	const beforeLineSet = before ? new Set(before.split("\n")) : new Set<string>();

	const beforeRules = beforeMetrics
		? new Set(
			runRulesFromMetrics(filePath, beforeMetrics).map((m) => m.rule),
		)
		: new Set<string>();

	// Rule matches (line-tagged): keep only ones whose post-edit line text
	// wasn't present in the pre-edit content. Always-line-0 rules go through
	// the file-level filter below.
	for (const match of runRulesFromMetrics(filePath, afterMetrics)) {
		if (match.line === 0) continue;
		const lineText = afterLines[match.line - 1] ?? "";
		const isLineNew = changed.has(match.line) || !beforeLineSet.has(lineText);
		if (!isLineNew) continue;
		records.push(makeRuleRecord(match, now, lineText));
	}

	// File-level rules (complexity / cognitive). Suppress if the rule already
	// fired pre-edit (same severity bucket) — the model didn't make it worse
	// in a way the threshold model cares about.
	for (const match of runRulesFromMetrics(filePath, afterMetrics)) {
		if (match.line !== 0) continue;
		if (beforeRules.has(match.rule)) continue;
		records.push(makeRuleRecord(match, now, ""));
	}

	// Threshold-only diagnostics owned by analyze (nesting + entropy).
	for (const rec of diagnosticsFromAnalysisDelta(
		filePath,
		beforeMetrics,
		afterMetrics,
		now,
	)) {
		records.push(rec);
	}

	return records;
}

function diagnosticsFromAnalysisDelta(
	filePath: string,
	beforeMetrics: FileMetrics | null,
	afterMetrics: FileMetrics,
	now: number,
): DiagnosticRecord[] {
	const out: DiagnosticRecord[] = [];
	const nestingBefore = beforeMetrics?.maxNesting ?? 0;
	if (
		afterMetrics.maxNesting > NESTING_THRESHOLD &&
		nestingBefore <= NESTING_THRESHOLD
	) {
		out.push(
			makeFactRecord(
				filePath,
				"oculus/deep-nesting",
				`Max nesting depth ${afterMetrics.maxNesting} exceeds threshold ${NESTING_THRESHOLD}`,
				afterMetrics.maxNesting > NESTING_ERROR_THRESHOLD ? "error" : "warning",
				now,
			),
		);
	}
	const entropyBefore = beforeMetrics?.entropy ?? 0;
	if (
		afterMetrics.entropy > ENTROPY_THRESHOLD &&
		entropyBefore <= ENTROPY_THRESHOLD
	) {
		out.push(
			makeFactRecord(
				filePath,
				"oculus/high-entropy",
				`Code entropy ${afterMetrics.entropy.toFixed(2)} bits/char is high (obfuscated or random-looking code)`,
				"info",
				now,
			),
		);
	}
	return out;
}

function resolveDisappeared(
	state: EngineState,
	filePath: string,
	currentIds: Set<string>,
): void {
	for (const record of state.diagnostics.values()) {
		if (record.diagnostic.filePath !== filePath) continue;
		if (record.status === "resolved") continue;
		if (!ANALYZE_OWNED_SOURCES.has(record.diagnostic.source)) continue;
		if (currentIds.has(record.id)) continue;
		state.markResolved(record.id);
	}
}

function countPreExistingLineTagged(
	filePath: string,
	after: string,
	afterMetrics: FileMetrics,
	before: string,
	changed: Set<number>,
): number {
	const afterLines = after.split("\n");
	const beforeLineSet = before ? new Set(before.split("\n")) : new Set<string>();
	let count = 0;
	for (const match of runRulesFromMetrics(filePath, afterMetrics)) {
		if (match.line === 0) continue;
		const lineText = afterLines[match.line - 1] ?? "";
		const isLineNew = changed.has(match.line) || !beforeLineSet.has(lineText);
		if (!isLineNew) count++;
	}
	return count;
}

/** Threshold-only diagnostics: kept as an exported helper for tests. */
export function diagnosticsFromAnalysis(
	analysis: { filePath: string; nestingDepth: number; entropy: number },
): DiagnosticRecord[] {
	const now = Date.now();
	const records: DiagnosticRecord[] = [];
	if (analysis.nestingDepth > NESTING_THRESHOLD) {
		records.push(
			makeFactRecord(
				analysis.filePath,
				"oculus/deep-nesting",
				`Max nesting depth ${analysis.nestingDepth} exceeds threshold ${NESTING_THRESHOLD}`,
				analysis.nestingDepth > NESTING_ERROR_THRESHOLD ? "error" : "warning",
				now,
			),
		);
	}
	if (analysis.entropy > ENTROPY_THRESHOLD) {
		records.push(
			makeFactRecord(
				analysis.filePath,
				"oculus/high-entropy",
				`Code entropy ${analysis.entropy.toFixed(2)} bits/char is high (obfuscated or random-looking code)`,
				"info",
				now,
			),
		);
	}
	return records;
}

function makeFactRecord(
	filePath: string,
	rule: string,
	message: string,
	severity: "error" | "warning" | "info" | "hint",
	now: number,
): DiagnosticRecord {
	const id = `${rule}:${filePath}`;
	return {
		id,
		diagnostic: {
			id,
			filePath,
			line: 0,
			column: 0,
			severity,
			rule,
			message,
			source: "oculus-native",
			hasFix: false,
			fixCount: 0,
			blastRadius: 1,
			age: 0,
		},
		status: "emitted",
		firstSeen: now,
		lastSeen: now,
	};
}

function makeRuleRecord(
	match: RuleMatch,
	now: number,
	lineText: string,
): DiagnosticRecord {
	return {
		id: match.id,
		diagnostic: {
			id: match.id,
			filePath: match.filePath,
			line: match.line,
			column: match.column,
			severity: match.severity,
			rule: match.rule,
			message: match.message,
			source: "oculus-rules",
			hasFix: false,
			fixCount: 0,
			blastRadius: 1,
			age: 0,
			snippet: clipSnippet(lineText),
			fix: match.fix,
		},
		status: "emitted",
		firstSeen: now,
		lastSeen: now,
	};
}

const SNIPPET_MAX = 120;

function clipSnippet(line: string): string | undefined {
	const trimmed = line.replace(/\s+$/, "");
	if (!trimmed) return undefined;
	if (trimmed.length <= SNIPPET_MAX) return trimmed;
	return `${trimmed.slice(0, SNIPPET_MAX - 1)}…`;
}

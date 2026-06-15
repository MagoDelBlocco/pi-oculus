/**
 * Diagnostic report builder.
 *
 * Takes accumulated diagnostics from engine state and produces a Markdown
 * report injected into the LLM context. The format is optimized for model
 * comprehension — no numeric scores (sort order is the priority signal),
 * issues grouped by file, code snippets inline, and a concrete Next:
 * directive at the end.
 *
 * Report structure:
 *   Header: Active: N (2 error, 3 warning). Resolved: M.
 *   Per-file sections with scored issues (max 20 per file)
 *   Resolved this cycle (max 10)
 *   Suggested fixes (autofix previews)
 *   Next: directive
 */

import {
	scoreBatch,
	countSeverities,
} from "../../native/src/native-bridge";
import type { EngineState } from "./state";
import type { DiagnosticRecord, Severity } from "./types";

/** Severity ordering for sort and display. */
const SEVERITY_ORDER: readonly Severity[] = ["error", "warning", "info", "hint"];
/** Display labels for severity badges in the report. */
const SEVERITY_LABEL: Record<Severity, string> = {
	error: "ERROR",
	warning: "WARN",
	info: "INFO",
	hint: "HINT",
};
/** Cap on issues shown per file — prevents context bloat on very noisy files. */
const ISSUE_LIMIT_PER_FILE = 20;
/** Cap on resolved issues shown — credit the model but don't dwell. */
const RESOLVED_LIMIT = 10;

/**
 * Build the Markdown-ish diagnostic report for the model.
 *
 * Format goals (informed by model UX, not human reading):
 *  - No numeric scores. Sort order IS the priority signal.
 *  - Active issues grouped by file so the model can fix everything in one
 *    file in one edit, not bounce between files.
 *  - Each issue is followed by a single-line code snippet and (when known)
 *    a one-line `Fix:` hint, closing the loop between "report seen" and
 *    "action taken."
 *  - No noise sections (lint zero-counts, redundant changed-files).
 *  - Ends with a `Next:` directive — concrete instruction, not data dump.
 *
 * Returns "" when there is nothing actionable to surface.
 */
export function buildDiagnosticReport(state: EngineState): string {
	const active = activeDiagnostics(state);
	const resolved = resolvedRecordsForReport(state);
	const hasContext =
		active.length > 0 ||
		resolved.length > 0 ||
		state.suggestedFixes.size > 0;
	if (!hasContext) return "";

	const lines: string[] = [];
	lines.push(header(active, resolved));

	if (active.length > 0) {
		appendByFile(lines, active, state);
	}

	if (resolved.length > 0) {
		appendResolved(lines, resolved);
	}

	if (state.suggestedFixes.size > 0) {
		appendSuggestedFixes(lines, state);
	}

	lines.push("");
	lines.push(nextDirective(active.length, resolved.length, state.suggestedFixes.size));

	return lines.join("\n");
}

//** Return all non-resolved diagnostics from engine state. */
export function activeDiagnostics(state: EngineState): DiagnosticRecord[] {
	return [...state.diagnostics.values()].filter((d) => d.status !== "resolved");
}

/* ----------------------- header ----------------------- */

function header(
	active: DiagnosticRecord[],
	resolved: DiagnosticRecord[],
): string {
	if (active.length === 0) {
		return `Active: 0. Resolved: ${resolved.length}.`;
	}
	const counts = countSeverities(active.map((d) => d.diagnostic.severity));
	const breakdown = SEVERITY_ORDER
		.filter((s) => counts[s] > 0)
		.map((s) => `${counts[s]} ${s}`)
		.join(", ");
	return `Active: ${active.length} (${breakdown}). Resolved: ${resolved.length}.`;
}

/* ----------------------- active issues, grouped by file ----------------------- */

function appendByFile(
	lines: string[],
	active: DiagnosticRecord[],
	state: EngineState,
): void {
	const scored = scoreActive(active, state);
	const scoreById = new Map(scored.map((s) => [s.id, s.score]));
	const byFile = new Map<string, DiagnosticRecord[]>();
	for (const rec of active) {
		const list = byFile.get(rec.diagnostic.filePath) ?? [];
		list.push(rec);
		byFile.set(rec.diagnostic.filePath, list);
	}

	// Order files by their max-priority issue; within a file, by priority.
	const fileMax = new Map<string, number>();
	for (const [file, recs] of byFile) {
		let best = 0;
		for (const r of recs) best = Math.max(best, scoreById.get(r.id) ?? 0);
		fileMax.set(file, best);
	}
	const sortedFiles = [...byFile.keys()].sort(
		(a, b) => (fileMax.get(b) ?? 0) - (fileMax.get(a) ?? 0),
	);

	for (const file of sortedFiles) {
		const recs = (byFile.get(file) ?? []).slice().sort(
			(a, b) => {
				const diff = (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0);
				if (diff !== 0) return diff;
				return a.diagnostic.line - b.diagnostic.line;
			},
		);
		lines.push("");
		lines.push(`${file} (${pluralize(recs.length, "issue")})`);
		const preExisting = state.preExistingIssues.get(file) ?? 0;
		if (preExisting > 0) {
			lines.push(`- pre-existing issues hidden: ${preExisting} (not blocking)`);
		}
		for (const rec of recs.slice(0, ISSUE_LIMIT_PER_FILE)) {
			renderIssue(lines, rec);
		}
		if (recs.length > ISSUE_LIMIT_PER_FILE) {
			lines.push(`- …and ${recs.length - ISSUE_LIMIT_PER_FILE} more in this file`);
		}
	}
}

function renderIssue(lines: string[], rec: DiagnosticRecord): void {
	const d = rec.diagnostic;
	const badge = `[${SEVERITY_LABEL[d.severity]}]`;
	const where = d.line > 0 ? `line ${d.line}` : "whole file";
	lines.push(`- ${badge} ${where} — ${d.message} [${d.rule}]`);
	if (d.snippet) {
		lines.push(`    ${d.snippet}`);
	}
	if (d.fix) {
		lines.push(`    Fix: ${d.fix}`);
	}
}

/* ----------------------- resolved + suggested fixes ----------------------- */

function appendResolved(lines: string[], resolved: DiagnosticRecord[]): void {
	lines.push("");
	lines.push(`Resolved this cycle (${resolved.length}):`);
	for (const r of resolved.slice(0, RESOLVED_LIMIT)) {
		const where = r.diagnostic.line > 0 ? `:${r.diagnostic.line}` : "";
		lines.push(
			`- ${r.diagnostic.filePath}${where} — ${r.diagnostic.message} [${r.diagnostic.rule}]`,
		);
	}
	if (resolved.length > RESOLVED_LIMIT) {
		lines.push(`- …and ${resolved.length - RESOLVED_LIMIT} more`);
	}
}

function appendSuggestedFixes(lines: string[], state: EngineState): void {
	const parts: string[] = [];
	for (const fix of state.suggestedFixes.values()) {
		const fixers = fix.fixers.length > 0 ? fix.fixers.join("+") : "autofix";
		parts.push(`${fix.filePath} (${fixers})`);
	}
	lines.push("");
	lines.push(`Suggested fixes: ${parts.join(", ")}.`);
}

/* ----------------------- closing directive ----------------------- */

function nextDirective(
	active: number,
	resolved: number,
	suggested: number,
): string {
	if (active > 0) {
		return "Next: address the active issues above before continuing.";
	}
	if (resolved > 0) {
		return "Next: clean run — keep going.";
	}
	if (suggested > 0) {
		return "Next: review the suggested fixes; apply if appropriate.";
	}
	return "Next: continue.";
}

/* ----------------------- internals ----------------------- */

function resolvedRecordsForReport(state: EngineState): DiagnosticRecord[] {
	const out: DiagnosticRecord[] = [];
	for (const id of state.resolvedSinceLastReport) {
		const rec = state.diagnostics.get(id);
		if (rec) out.push(rec);
	}
	return out;
}

function scoreActive(active: DiagnosticRecord[], state: EngineState) {
	const now = Date.now();
	const VALID_SEVERITIES = new Set(["error", "warning", "info", "hint"]);
	const inputs = active
		.filter((d) => VALID_SEVERITIES.has(d.diagnostic.severity)) // sanitize
		.map((d) => {
			const lines = state.touchedLines.get(d.diagnostic.filePath);
			const arr = lines ? [...lines] : [];
			const start = arr.length > 0 ? Math.min(...arr) : -1;
			const end = arr.length > 0 ? Math.max(...arr) : -1;
			return {
				id: d.diagnostic.id,
				filePath: d.diagnostic.filePath ?? "",
				line: typeof d.diagnostic.line === "number" ? d.diagnostic.line : 0,
				column: typeof d.diagnostic.column === "number" ? d.diagnostic.column : 0,
				severity: d.diagnostic.severity,
				rule: d.diagnostic.rule ?? "",
				message: d.diagnostic.message ?? "",
				source: d.diagnostic.source ?? "",
				hasFix: !!d.diagnostic.hasFix,
				fixCount: typeof d.diagnostic.fixCount === "number" ? d.diagnostic.fixCount : 0,
				blastRadius: typeof d.diagnostic.blastRadius === "number" ? d.diagnostic.blastRadius : 1,
				age: now - d.firstSeen,
				touchedStart: start,
				touchedEnd: end,
				touchedLines: arr,
			};
		});
	try {
		return scoreBatch(inputs);
	} catch {
		return inputs.map((d) => ({ id: d.id, score: 0 }));
	}
}

function pluralize(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

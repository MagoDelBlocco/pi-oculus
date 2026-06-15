import type { LintResult } from "../../lint/src/index";
import type { FileMetrics } from "../../native/src/native-bridge";
import type { DiagnosticRecord } from "./types";

/** A fix proposed by the autofix pipeline; surfaced in the diagnostic report. */
export interface SuggestedFix {
	readonly filePath: string;
	readonly fixers: readonly string[];   // fixers that contributed (e.g. ["eslint", "prettier"])
	readonly charsChanged: number;        // heuristic; for sizing the report bullet
	readonly preview: string;             // short human-readable summary
}

type Listener = (record: DiagnosticRecord) => void;

/**
 * Engine state. Tracks everything needed to produce diff-aware diagnostics:
 *  - `diagnostics` accumulates across the session, with status reflecting
 *    whether each issue is currently active or has been resolved.
 *  - `fileSnapshots` + `fileSnapshotMetrics` capture pre-edit content & metrics
 *    so we can tell what the model actually introduced vs. what was already
 *    there.
 *  - `lintPending` is the queue of files waiting for end-of-turn linting
 *    (linting per-edit is too slow for tight agent loops).
 *  - `resolvedSinceLastReport` is the IDs that flipped to resolved since the
 *    last context-injection, so the report can credit the model with its fixes.
 *  - `touchedLines` keeps per-file sets of changed line numbers so scoring's
 *    proximity term reflects exactly where the model edited (not a bounding
 *    box, which is misleading for sparse edits).
 */
export class EngineState {
	static readonly MAX_RECORDS = 500;
	readonly diagnostics = new Map<string, DiagnosticRecord>();

	readonly changedFiles = new Set<string>();
	// Keyed `${filePath}::${linterName}` so multiple linters can hold their own
	// result for the same file (eslint + prettier + biome no longer overwrite
	// each other).
	readonly lintResults = new Map<string, LintResult>();
	readonly fileSnapshots = new Map<string, string>();
	readonly fileSnapshotMetrics = new Map<string, FileMetrics>();
	readonly lintPending = new Set<string>();
	readonly preExistingIssues = new Map<string, number>();
	readonly resolvedSinceLastReport = new Set<string>();
	/**
	 * Per-file set of changed line numbers (1-indexed) for the current turn.
	 * Used by scoring's proximity term so it can decay with the distance to
	 * the nearest changed line rather than the loose bounding box.
	 */
	readonly touchedLines = new Map<string, Set<number>>();
	/** Autofix proposals produced this turn, keyed by file path. */
	readonly suggestedFixes = new Map<string, SuggestedFix>();
	pendingFileChange = false;
	pendingReport: string | undefined = undefined;
	/**
	 * Whether the preamble explaining what the diagnostic report is has been
	 * injected this session. Subsequent context events wrap the report in
	 * `<oculus-report>` tags without re-explaining — the tags alone are signal
	 * enough, and re-sending the preamble trains the model to skim the wrapper.
	 */
	preambleSent = false;

	private listeners: Listener[] = [];

	upsertDiagnostic(record: DiagnosticRecord): void {
		// Reappearing diagnostic: clear any "resolved-this-cycle" claim — we'd
		// look silly telling the model "you fixed X" and then reporting X again.
		this.resolvedSinceLastReport.delete(record.id);
		this.diagnostics.set(record.id, record);
		this.evictIfOverCap();
		for (const fn of this.listeners) fn(record);
	}

	private evictIfOverCap(): void {
		if (this.diagnostics.size <= EngineState.MAX_RECORDS) return;
		const resolved = [...this.diagnostics.entries()]
			.filter(([, rec]) => rec.status === "resolved")
			.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
		for (const [id] of resolved) {
			if (this.diagnostics.size <= EngineState.MAX_RECORDS) break;
			this.diagnostics.delete(id);
			this.resolvedSinceLastReport.delete(id);
		}
	}

	markResolved(id: string): void {
		const rec = this.diagnostics.get(id);
		if (!rec || rec.status === "resolved") return;
		rec.status = "resolved";
		this.resolvedSinceLastReport.add(id);
	}

	subscribe(fn: Listener): () => void {
		this.listeners.push(fn);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== fn);
		};
	}

	reset(): void {
		this.diagnostics.clear();

		this.changedFiles.clear();
		this.lintResults.clear();
		this.fileSnapshots.clear();
		this.fileSnapshotMetrics.clear();
		this.lintPending.clear();
		this.preExistingIssues.clear();
		this.resolvedSinceLastReport.clear();
		this.touchedLines.clear();
		this.suggestedFixes.clear();
		this.pendingFileChange = false;
		this.pendingReport = undefined;
		this.preambleSent = false;
	}
}

export function createState(): EngineState {
	return new EngineState();
}

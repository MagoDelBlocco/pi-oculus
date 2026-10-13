/**
 * Core type definitions for the diagnostic engine.
 *
 * `Diagnostic` represents a single finding (one line in the report).
 * `DiagnosticRecord` wraps it with lifecycle metadata (status, timestamps).
 * `Severity` is re-exported from oculus-rules for convenience.
 */

import type { Severity } from "../../rules/src/types";

export type { Severity };

/**
 * A single diagnostic finding.
 *
 * Carries everything needed to render one row in the diagnostic report:
 * location (file, line, column), classification (severity, rule), human
 * text (message, snippet, fix hint), and metadata for scoring (hasFix,
 * fixCount, blastRadius, age).
 */
export interface Diagnostic {
	/** Stable unique identifier (e.g. "oculus/debugger-statement:file.ts:5:3"). */
	id: string;
	/** Absolute or relative file path. */
	filePath: string;
	/** 1-indexed line number. 0 for file-level diagnostics. */
	line: number;
	/** 1-indexed column number. 0 for file-level diagnostics. */
	column: number;
	/** Severity bucket — drives sort order and visual weight. */
	severity: Severity;
	/** Canonical rule identifier (e.g. "oculus/console-log"). */
	rule: string;
	/** Human-readable description of the issue. */
	message: string;
	/** Origin of the diagnostic (e.g. "oculus-rules", "eslint", "prettier"). */
	source: string;
	/** True when an autofix is available for this diagnostic. */
	hasFix: boolean;
	/** Number of fixable sub-issues (e.g. multiple formatting fixes). */
	fixCount: number;
	/** Estimated scope of impact: 1 = local, higher = wider blast radius. */
	blastRadius: number;
	/** Milliseconds since first detection. Used for score decay. */
	age: number;
	/** The relevant line from the file at diagnosis time, for inline display. */
	snippet?: string;
	/** Short one-line fix hint for the model. Populated for oculus native rules. */
	fix?: string;
}

/**
 * Lifecycle status of a diagnostic record.
 *
 * - `emitted` — newly detected, awaiting model attention
 * - `acknowledged` — model has seen the report (tracked for telemetry)
 * - `addressed` — model made changes that may have fixed it
 * - `resolved` — diagnostic no longer appears in post-edit analysis
 */
export type DiagnosticStatus =
	| "emitted"
	| "acknowledged"
	| "addressed"
	| "resolved";

/**
 * A diagnostic wrapped with tracking metadata.
 *
 * The engine stores these in `state.diagnostics` keyed by id. Status
 * transitions from emitted → resolved as the model fixes issues across
 * turns. Timestamps enable age-based score decay.
 */
export interface DiagnosticRecord {
	/** Stable unique identifier matching `diagnostic.id`. */
	id: string;
	/** The diagnostic payload. */
	diagnostic: Diagnostic;
	/** Current lifecycle status. */
	status: DiagnosticStatus;
	/** Timestamp when this diagnostic was first detected. */
	firstSeen: number;
	/** Timestamp of the most recent re-detection. */
	lastSeen: number;
}

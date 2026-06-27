/**
 * oculus-view — TUI widget for diagnostic issues.
 *
 * The widget renders from a `snapshotFn` callback provided by the engine,
 * ensuring it always shows exactly what the model sees. There is no separate
 * issue store — the engine's `state.diagnostics` is the single source of
 * truth. The widget re-renders whenever the engine notifies it of changes.
 *
 * This avoids the class of bugs where a separate tracker drifts from engine
 * state (stale entries, resolved issues not removed, etc.).
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/**
 * One issue for display in the widget.
 *
 * Mirrors the shape of DiagnosticRecord but scoped to what the widget needs.
 */
export interface IssueEntry {
	/** Stable unique identifier matching the diagnostic id. */
	id: string;
	/** File path. */
	file: string;
	/** 1-indexed line number. */
	line: number;
	/** Severity bucket. */
	severity: "error" | "warning" | "info" | "hint";
	/** Canonical rule identifier. */
	rule: string;
	/** Human-readable message. */
	message: string;
	/** Current lifecycle status. */
	status: "open" | "acknowledged" | "resolved";
}

/**
 * Snapshot function provided by the engine. Returns all active (non-resolved)
 * issues at render time. This is the single source of truth — the widget
 * never caches issues itself.
 */
export type IssueSnapshotFn = () => IssueEntry[];

/**
 * Set up the TUI widget that renders below the editor.
 *
 * Shows a summary of open issues grouped by severity, with up to 5 items
 * per severity level. Re-renders automatically when `onChange` fires.
 *
 * The widget reads from `snapshotFn()` on every render, so it always shows
 * exactly what the engine state contains — no drift possible.
 *
 * @param ui - Pi's UI context (may be undefined in headless mode)
 * @param snapshotFn - Function that returns current open issues from engine state
 * @returns `update` — call to re-render the widget from the latest snapshot.
 *          The engine wires this to `EngineState.subscribe` so the widget
 *          repaints on every diagnostic change. No-op when the UI can't host
 *          a widget (headless / older runtimes).
 */
export function setupWidget(
	ui: ExtensionUIContext | undefined,
	snapshotFn: IssueSnapshotFn,
): () => void {
	const WIDGET_KEY = "oculus:issues";

	const setWidget = ui?.setWidget;

	/** Render the widget content as lines of text. */
	function render(): string[] {
		const open = snapshotFn();
		if (open.length === 0) {
			return [];
		}

		const lines = [`Oculus: ${open.length} outstanding issues`];
		const bySeverity = new Map<string, IssueEntry[]>();
		for (const issue of open) {
			const arr = bySeverity.get(issue.severity) ?? [];
			arr.push(issue);
			bySeverity.set(issue.severity, arr);
		}

		// Show severities in priority order, max 5 items each.
		const order = ["error", "warning", "info", "hint"];
		for (const sev of order) {
			const items = bySeverity.get(sev);
			if (!items?.length) continue;
			lines.push(`  ${sev.toUpperCase()}: ${items.length}`);
			for (const item of items.slice(0, 5)) {
				lines.push(`    ${item.file}:${item.line} ${item.message}`);
			}
			if (items.length > 5) {
				lines.push(`    ...and ${items.length - 5} more`);
			}
		}

		return lines;
	}

	/** Re-render the widget with fresh content from the snapshot. */
	function update(): void {
		if (typeof setWidget !== "function") return;
		setWidget(WIDGET_KEY, render(), { placement: "belowEditor" });
	}

	// Initial render.
	update();

	return update;
}

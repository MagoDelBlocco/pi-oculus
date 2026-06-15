/**
 * oculus-core — Pi extension entry point and public API barrel.
 *
 * This module exports everything needed to use or test the diagnostic engine:
 * state management, event handlers, analysis, linting, autofix, reporting,
 * suppression, and type definitions.
 *
 * As a Pi extension, the default export `oculus(pi)` is the factory function
 * that wires up event handlers and creates engine state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createState } from "./state";
import { registerHandlers } from "./handlers";

/**
 * Pi extension factory. Called by pi at startup.
 *
 * Creates a fresh EngineState and registers all lifecycle event handlers.
 * The state is scoped to the session — it is reset on session_start and
 * discarded on session_shutdown.
 */
export default function oculus(
	pi: ExtensionAPI,
): void {
	const state = createState();
	registerHandlers(pi, state);
}

export { createState, EngineState } from "./state";
export {
	registerHandlers,
	extractDiagnostics,
} from "./handlers";
export {
	analyzeChangedFiles,
	diagnosticsFromAnalysis,
} from "./analyze";
export { lintChangedFiles } from "./lint";
export { runAutofixSuggestions } from "./autofix";
export { buildDiagnosticReport, activeDiagnostics } from "./report";
export { updateOculusStatus } from "./status";
export { makeReadFile } from "./io";
export { parseSuppressions, isSuppressed } from "./suppression";
export type { SuppressionMap } from "./suppression";
export {
	shouldSkipAnalysis,
	shouldSkipByPath,
	MAX_ANALYSIS_BYTES,
} from "./guard";
export { registerAnalyzeCommand } from "./analyze-command";
export { analyzeCwd, formatCwdReport, collectSourceFiles } from "./analyze-cwd";
export type { FileAnalysis, CwdAnalysis } from "./analyze-cwd";
export type {
	Diagnostic,
	DiagnosticRecord,
	DiagnosticStatus,
	Severity,
} from "./types";
export type { SuggestedFix } from "./state";

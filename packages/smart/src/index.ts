/**
 * oculus-smart — Scoring, autofix pipeline, and resolution lifecycle.
 *
 * This package provides the "smart" layer on top of raw diagnostics:
 *
 * - **Scoring** — weighted priority computation (severity + proximity +
 *   blast radius + fixability + age decay). Exported from the native bridge.
 * - **Autofix pipeline** — dry-run fixer chain (eslint --fix-dry-run,
 *   prettier, biome) that proposes changes without writing to disk.
 * - **Resolution tracking** — determines which diagnostics disappeared
 *   after an edit and credits the model for its fixes.
 */

/** Diagnostic scoring — weighted priority from native addon. */
export {
	scoreDiagnostic,
	scoreBatch,
	classifySeverity,
} from "../../native/src/native-bridge";

/** Autofix pipeline — dry-run fixers that propose changes. */
export {
	AutofixPipeline,
	createAutofixPipeline,
} from "./autofix";
export type {
	AutofixResult,
	AutofixOptions,
	FixerName,
	FixerOutcome,
} from "./autofix";

/**
 * Autofix integration layer.
 *
 * Bridges the lint diagnostics in engine state with the AutofixPipeline
 * (packages/smart/autofix). Runs fixers in dry-run mode — the pipeline
 * returns proposed changes but never writes to disk. The model decides
 * whether to accept them.
 */

import { AutofixPipeline } from "../../smart/src/autofix";
import type { AutofixOptions } from "../../smart/src/autofix";
import type { EngineState, SuggestedFix } from "./state";
import type { ReadFile } from "./io";
import { shouldSkipAnalysis, shouldSkipByPath } from "./guard";

/** Dependency injection for testing — swap in a mock pipeline. */
export interface AutofixDeps {
	/** Factory for the autofix pipeline. Defaults to AutofixPipeline. */
	createPipeline?: () => Pick<AutofixPipeline, "apply">;
	/** Options forwarded to AutofixPipeline constructor. */
	options?: AutofixOptions;
}

/**
 * Run the autofix pipeline against every file that has at least one active
 * lint diagnostic with `hasFix: true`. Restricting to files where the lint
 * pass already said "there's a fix available" avoids speculative invocations
 * on files autofix has nothing useful to do for.
 *
 * Populates `state.suggestedFixes` with a short preview for each file the
 * pipeline successfully proposes changes to. The fix is NOT applied — the
 * model decides whether to take it.
 */
export async function runAutofixSuggestions(
	state: EngineState,
	readFile: ReadFile,
	deps?: AutofixDeps,
): Promise<void> {
	const candidates = candidateFiles(state);
	if (candidates.length === 0) return;

	const pipeline =
		deps?.createPipeline?.() ?? new AutofixPipeline(deps?.options);

	await Promise.all(
		candidates.map(async (filePath) => {
			if (shouldSkipByPath(filePath)) return;
			let content: string;
			try {
				content = await readFile(filePath);
			} catch {
				return;
			}
			if (!content || shouldSkipAnalysis(content)) return;

			const result = await pipeline.apply(filePath, content);
			if (!result.applied || result.content === content) return;

			const fixers = result.fixers
				.filter((f) => f.applied)
				.map((f) => f.fixer);
			const fix: SuggestedFix = {
				filePath,
				fixers,
				charsChanged: result.totalChars,
				preview: summarize(result.before, result.content),
			};
			state.suggestedFixes.set(filePath, fix);
		}),
	);
}

/** Collect file paths that have at least one active fixable diagnostic. */
function candidateFiles(state: EngineState): string[] {
	const out = new Set<string>();
	for (const record of state.diagnostics.values()) {
		if (record.status === "resolved") continue;
		if (!record.diagnostic.hasFix) continue;
		if (!record.diagnostic.filePath) continue;
		out.add(record.diagnostic.filePath);
	}
	return [...out];
}

/** Build a human-readable summary of the autofix diff (e.g. "+3 lines (120 → 145 bytes)"). */
function summarize(before: string, after: string): string {
	const beforeLines = before.split("\n").length;
	const afterLines = after.split("\n").length;
	const lineDelta = afterLines - beforeLines;
	const sign = lineDelta > 0 ? "+" : lineDelta < 0 ? "" : "±";
	return `${sign}${lineDelta} lines (${before.length} → ${after.length} bytes)`;
}

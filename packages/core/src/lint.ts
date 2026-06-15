import { LinterRunner } from "../../lint/src/index";
import type {
	LintResult,
	LinterConfig,
	LintDiagnostic,
} from "../../lint/src/index";
import type { EngineState } from "./state";
import type { DiagnosticRecord } from "./types";
import type { ReadFile } from "./io";
import { changedLines } from "./diff";
import { parseSuppressions, isSuppressed } from "./suppression";
import { shouldSkipAnalysis, shouldSkipByPath } from "./guard";

interface RunnerLike {
	lintFile: (filePath: string, content: string) => Promise<LintResult[]>;
}

export interface LintDeps {
	createRunner?: () => RunnerLike;
	linters?: readonly LinterConfig[];
}

const LINT_SOURCE_PREFIXES = ["eslint", "prettier", "biome"] as const;

/**
 * Run linters on every changed file. Files are read + linted in parallel.
 *
 * Diff-awareness: each linter's output is filtered against the pre-edit
 * snapshot so issues on lines the model didn't touch aren't reported. The
 * unfiltered totals are kept in `state.lintResults` for the Lint Results
 * section (counts pre-filter); only the filtered diagnostics are upserted
 * into `state.diagnostics` (drives priority + resolution).
 *
 * Resolution: after a successful per-file lint pass, any previously-emitted
 * lint diagnostic for that file whose id didn't reappear is marked resolved,
 * mirroring what `analyzeChangedFiles` does for native rule matches.
 */
export async function lintChangedFiles(
	state: EngineState,
	readFile: ReadFile,
	deps?: LintDeps,
): Promise<void> {
	// Use injected runner for tests, otherwise auto-discover linters.
	const runner = deps?.createRunner
		? deps.createRunner()
		: await LinterRunner.create(process.cwd());

	const files = [...state.changedFiles].filter((p) => !shouldSkipByPath(p));
	const work = await Promise.all(
		files.map(async (filePath) => {
			try {
				const content = await readFile(filePath);
				if (shouldSkipAnalysis(content)) {
					return { filePath, content, ok: false as const };
				}
				return { filePath, content, ok: true as const };
			} catch {
				return { filePath, content: "", ok: false as const };
			}
		}),
	);

	const linted = await Promise.all(
		work
			.filter((w) => w.ok)
			.map(async (w) => {
				try {
					const results = await runner.lintFile(w.filePath, w.content);
					return {
						filePath: w.filePath,
						content: w.content,
						results,
						ok: true as const,
					};
				} catch {
					return {
						filePath: w.filePath,
						content: w.content,
						results: [],
						ok: false as const,
					};
				}
			}),
	);

	for (const item of linted) {
		if (!item.ok) continue;
		const before = state.fileSnapshots.get(item.filePath) ?? "";
		const diffFilter = makeDiffFilter(before, item.content);
		const suppressions = parseSuppressions(item.content);
		const afterLines = item.content.split("\n");

		const seenIds = new Set<string>();
		for (const result of item.results) {
			state.lintResults.set(`${item.filePath}::${result.linter}`, result);

			for (const diag of result.diagnostics) {
				if (!diffFilter(diag)) continue;
				if (isSuppressed(suppressions, diag.line, diag.rule)) continue;
				seenIds.add(diag.id);
				const snippet =
					diag.line > 0 ? clipSnippet(afterLines[diag.line - 1] ?? "") : undefined;
				upsertLintDiagnostic(state, diag, snippet);
			}
		}
		resolveDisappearedLint(state, item.filePath, seenIds);
	}
}

const SNIPPET_MAX = 120;

function clipSnippet(line: string): string | undefined {
	const trimmed = line.replace(/\s+$/, "");
	if (!trimmed) return undefined;
	if (trimmed.length <= SNIPPET_MAX) return trimmed;
	return `${trimmed.slice(0, SNIPPET_MAX - 1)}…`;
}

function makeDiffFilter(
	before: string,
	after: string,
): (diag: LintDiagnostic) => boolean {
	const changed = changedLines(before, after);
	// New file (no prior snapshot): trust every line — there's no "pre-existing"
	// state to suppress against.
	if (!before) return () => true;
	const afterLines = after.split("\n");
	const beforeLineSet = new Set(before.split("\n"));
	return (diag) => {
		// Whole-file diagnostics (line 0 / no positional info) can't be diffed —
		// keep them; the lint count remains informative.
		if (!diag.line || diag.line < 1) return true;
		if (changed.has(diag.line)) return true;
		const lineText = afterLines[diag.line - 1] ?? "";
		return !beforeLineSet.has(lineText);
	};
}

function upsertLintDiagnostic(
	state: EngineState,
	diag: LintDiagnostic,
	snippet: string | undefined,
): void {
	const now = Date.now();
	const record: DiagnosticRecord = {
		id: diag.id,
		diagnostic: { ...diag, age: 0, snippet },
		status: "emitted",
		firstSeen: now,
		lastSeen: now,
	};
	state.upsertDiagnostic(record);
}

function resolveDisappearedLint(
	state: EngineState,
	filePath: string,
	seenIds: Set<string>,
): void {
	for (const record of state.diagnostics.values()) {
		if (record.diagnostic.filePath !== filePath) continue;
		if (record.status === "resolved") continue;
		if (!isLintSourced(record.diagnostic.source)) continue;
		if (seenIds.has(record.id)) continue;
		state.markResolved(record.id);
	}
}

function isLintSourced(source: string): boolean {
	return LINT_SOURCE_PREFIXES.some((p) => source === p);
}

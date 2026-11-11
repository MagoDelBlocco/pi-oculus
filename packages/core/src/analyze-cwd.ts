/**
 * CWD-wide diagnostic analyzer.
 *
 * Walks the current working directory, collects source files, and runs
 * the full diagnostic pipeline (native analysis + pattern rules + linters)
 * on every file. Used by the /oculus-analyze command.
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { resolve, extname } from "node:path";
import { analyzeFile } from "../../native/src/native-bridge";
import { runRulesFromMetrics } from "../../rules/src/index";
import { runBuiltInAstRules } from "../../rules/src/tree-sitter";
import { runSemanticDiagnostics } from "../../rules/src/semantic";
import { runLeanBeamBatch, leanFailureDiagnostic } from "../../rules/src/semantic/lean-beam";
import type { RuleMatch } from "../../rules/src/types";
import { LinterRunner, type LintResult } from "../../lint/src/index";
import { shouldSkipByPath, shouldSkipAnalysis, isTmpPath } from "./guard";

const SKIP_DIRS = new Set([
	"node_modules", ".git", ".pi", ".next", ".nuxt", ".cache",
	"dist", "build", ".build", ".lake", "coverage", ".vscode", ".idea",
]);

/** Result of analyzing one file. */
export interface FileAnalysis {
	filePath: string;
	rules: RuleMatch[];
	lints: LintResult[];
	error?: string;
}

/** Result of analyzing the entire CWD. */
export interface CwdAnalysis {
	files: FileAnalysis[];
	totalFiles: number;
	totalRules: number;
	totalLints: number;
	durationMs: number;
	/** True when the source-file limit excluded additional files. */
	truncated: boolean;
}

/** Recursively collect source files from a directory. */
export function collectSourceFiles(dir: string, maxFiles = 500): string[] {
	const files: string[] = [];
	walk(resolve(dir), files, maxFiles);
	return files;
}

function walk(dir: string, acc: string[], max: number): void {
	if (acc.length >= max) return;
	let entries: Dirent[];
	try { entries = readdirSync(dir, { withFileTypes: true }); }
	catch { return; }
	for (const e of entries) {
		if (acc.length >= max) break;
		const p = resolve(dir, e.name);
		// Prune the /tmp subtree wholesale — nothing under the scratch
		// directory is ever a diagnostic target (see guard.isTmpPath).
		if (isTmpPath(p)) continue;
		if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(p, acc, max);
		else if (e.isFile() && isSource(e.name, p)) acc.push(p);
	}
}

function isSource(_name: string, path: string): boolean {
	return !shouldSkipByPath(path);
}

/** Analyze all source files in the given directory. */
export async function analyzeCwd(
	cwd: string = process.cwd(),
	maxFiles = 500,
): Promise<CwdAnalysis> {
	const start = performance.now();
	const discovered = collectSourceFiles(cwd, maxFiles + 1);
	const truncated = discovered.length > maxFiles;
	const files = discovered.slice(0, maxFiles);
	const results = await phaseNative(files);
	phaseAst(results);
	await phaseSemantic(results, cwd);
	await phaseLean(results, cwd);
	await phaseLint(results, cwd);
	return summarize(results, start, truncated);
}

async function phaseLean(results: FileAnalysis[], cwd: string): Promise<void> {
	const files = results.filter((r) => !r.error && r.filePath.toLowerCase().endsWith(".lean")).map((r) => r.filePath);
	const checkedByFile = await runLeanBeamBatch(files, 60_000, undefined, cwd);
	for (const result of results) {
		if (result.error || !result.filePath.toLowerCase().endsWith(".lean")) continue;
		const checked = checkedByFile.get(result.filePath);
		if (!checked) continue;
		result.lints.push({ filePath: result.filePath, linter: "lean-beam",
			diagnostics: checked.checked ? checked.diagnostics : checked.error ? [leanFailureDiagnostic(result.filePath, checked.error)] : [],
			output: "", durationMs: 0, error: checked.error });
	}
}

/** Phase 1: native analysis (sequential). */
async function phaseNative(files: string[]): Promise<FileAnalysis[]> {
	const out: FileAnalysis[] = [];
	for (const fp of files) {
		const content = readSafe(fp);
		if (content === null) {
			out.push({ filePath: fp, rules: [], lints: [], error: "Could not read file" });
			continue;
		}
		if (shouldSkipAnalysis(content)) continue;
		if (fp.toLowerCase().endsWith(".lean")) {
			out.push({ filePath: fp, rules: [], lints: [] });
			continue;
		}
		const m = safeAnalyze(content, fp, out);
		if (m) out.push({ filePath: fp, rules: runRulesFromMetrics(fp, m), lints: [] });
	}
	return out;
}

/** Phase 1.5: AST analysis (tree-sitter structural rules). */
function phaseAst(results: FileAnalysis[]): void {
	const AST_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
	for (const r of results) {
		if (r.error) continue;
		if (!AST_EXTS.has(extname(r.filePath).toLowerCase())) continue;
		const content = readSafe(r.filePath);
		if (!content) continue;
		try {
			const astMatches = runBuiltInAstRules(r.filePath, content);
			r.rules.push(...astMatches);
		} catch {
			// Intentional: tree-sitter may be unavailable in some environments.
			// AST rules are supplementary — the engine operates without them.
		}
	}
}

/** Phase 1.75: Semantic analysis (type checkers + semgrep). */
async function phaseSemantic(results: FileAnalysis[], cwd: string): Promise<void> {
  const candidates = results
    .filter((r) => !r.error)
    .map((r) => ({ path: r.filePath, content: readSafe(r.filePath) ?? "" }))
    .filter((f) => !shouldSkipAnalysis(f.content));
  if (candidates.length === 0) return;

  try {
    const semanticResults = await runSemanticDiagnostics(candidates, { cwd });
    for (const r of results) {
      const diags = semanticResults.get(r.filePath);
      if (diags && diags.length > 0) {
        // Semantic diagnostics go into lints (they share the LintDiagnostic shape)
        r.lints.push({
          filePath: r.filePath,
          linter: "semantic",
          diagnostics: diags,
          output: "",
          durationMs: 0,
        });
      }
    }
  } catch {
    // Intentional: type checkers may fail due to missing project config
    // (tsconfig.json, pyproject.toml, Cargo.toml) or unavailable binaries.
    // Semantic analysis is supplementary — the engine operates without it.
  }
}

/** Phase 2: linting (parallel). */
async function phaseLint(results: FileAnalysis[], cwd: string): Promise<void> {
	const candidates = results
		.filter((r) => !r.error)
		.map((r) => ({ filePath: r.filePath, content: readSafe(r.filePath) ?? "" }))
		.filter((f) => !shouldSkipAnalysis(f.content));
	if (candidates.length === 0) return;
	const runner = await LinterRunner.create(cwd);
	const map = await runner.lintFiles(candidates);
	for (const r of results) {
		const lints = map.get(r.filePath);
		if (lints) r.lints.push(...lints);
	}
}

/** Build the summary struct. */
function summarize(results: FileAnalysis[], start: number, truncated: boolean): CwdAnalysis {
	return {
		files: results,
		totalFiles: results.length,
		totalRules: sum(results, (r) => r.rules.length),
		totalLints: sum(results, (r) => r.lints.flatMap((l) => l.diagnostics).length),
		durationMs: Math.round(performance.now() - start),
		truncated,
	};
}

function sum<T>(arr: T[], fn: (t: T) => number): number {
	return arr.reduce((s, t) => s + fn(t), 0);
}

function readSafe(fp: string): string | null {
	try { return readFileSync(fp, "utf8"); }
	catch { return null; }
}

function safeAnalyze(
	content: string, fp: string, out: FileAnalysis[],
): ReturnType<typeof analyzeFile> | null {
	try { return analyzeFile(content); }
	catch (e) {
		out.push({ filePath: fp, rules: [], lints: [], error: String(e) });
		return null;
	}
}

// --- Report formatting ---

/** All diagnostics (rules + lints) for one file. */
function allDiags(file: FileAnalysis) {
	return [
		...file.rules.map((r) => ({ ...r, source: "oculus-rules" })),
		...file.lints.flatMap((l) => l.diagnostics),
	];
}

/** Highest severity for a file, or "clean". */
type SeverityBucket = "error" | "warning" | "info" | "clean";

function highestSeverity(file: FileAnalysis): SeverityBucket {
	if (file.error) return "warning";
	const diags = allDiags(file);
	if (diags.some((d) => d.severity === "error")) return "error";
	if (diags.some((d) => d.severity === "warning")) return "warning";
	return diags.length > 0 ? "info" : "clean";
}

/** Format analysis results as a Markdown report. */
export function formatCwdReport(a: CwdAnalysis): string {
	const lines: string[] = [];
	lines.push("## Oculus CWD Analysis");
	lines.push(
		`Scanned ${a.totalFiles} file(s) in ${a.durationMs}ms. ` +
		`Found ${a.totalRules} rule match(es) and ${a.totalLints} lint diagnostic(s).`,
	);
	if (a.truncated) lines.push("Scan limit reached; additional source files were not checked.");
	lines.push("");
	const groups: Record<SeverityBucket, FileAnalysis[]> = { error: [], warning: [], info: [], clean: [] };
	for (const f of a.files) groups[highestSeverity(f)].push(f);
	appendGroup(lines, "Errors", groups.error);
	appendGroup(lines, "Warnings", groups.warning);
	appendGroup(lines, "Info", groups.info);
	appendGroup(lines, "Clean", groups.clean, true);
	return lines.join("\n");
}

function appendGroup(
	lines: string[], label: string, files: FileAnalysis[], simple = false,
): void {
	if (files.length === 0) return;
	lines.push(`### ${label} (${files.length} file(s))`);
	for (const f of files) {
		if (simple) { lines.push(`- \`${f.filePath}\``); continue; }
		if (f.error) { lines.push(`- \`${f.filePath}\` — ${f.error}`); continue; }
		appendOneFile(lines, f);
	}
	lines.push("");
}

function appendOneFile(lines: string[], f: FileAnalysis): void {
	const diags = allDiags(f);
	if (diags.length === 0) return;
	lines.push(`- \`${f.filePath}\` (${diags.length} issue(s))`);
	for (const d of diags.slice(0, 10)) {
		const w = d.line > 0 ? `:${d.line}` : "";
		lines.push(`    [${(d.severity ?? "INFO").toUpperCase()}] ${d.message} [${d.rule ?? d.source}]${w}`);
	}
	if (diags.length > 10) lines.push(`    ...and ${diags.length - 10} more`);
}

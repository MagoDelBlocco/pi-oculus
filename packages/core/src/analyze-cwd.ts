/**
 * CWD-wide diagnostic analyzer.
 *
 * Walks the current working directory, collects source files, and runs
 * the full diagnostic pipeline (native analysis + pattern rules + linters)
 * on every file. Used by the /oculus-analyze command.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { analyzeFile } from "../../native/src/native-bridge";
import { runRulesFromMetrics } from "../../rules/src/index";
import { runBuiltInAstRules } from "../../rules/src/tree-sitter";
import { runSemanticAnalysis } from "../../rules/src/semantic";
import type { RuleMatch } from "../../rules/src/types";
import { LinterRunner, type LintResult } from "../../lint/src/index";
import { shouldSkipByPath, shouldSkipAnalysis } from "./guard";

const SKIP_DIRS = new Set([
	"node_modules", ".git", ".pi", ".next", ".nuxt", ".cache",
	"dist", "build", "coverage", ".vscode", ".idea",
]);

const SOURCE_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go",
	".java", ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".rb", ".php",
	".cs", ".swift", ".kt", ".scala", ".sh", ".bash", ".zsh", ".css",
	".scss", ".less", ".json", ".jsonc", ".yaml", ".yml", ".toml",
	".md", ".mdx", ".html", ".vue", ".svelte", ".lean",
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
}

/** Recursively collect source files from a directory. */
export function collectSourceFiles(dir: string, maxFiles = 500): string[] {
	const files: string[] = [];
	walk(resolve(dir), files, maxFiles);
	return files;
}

function walk(dir: string, acc: string[], max: number): void {
	if (acc.length >= max) return;
	let entries: string[];
	try { entries = readdirSync(dir, { withFileTypes: true }); }
	catch { return; }
	for (const e of entries) {
		if (acc.length >= max) break;
		const p = resolve(dir, e.name);
		if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(p, acc, max);
		else if (e.isFile() && isSource(e.name, p)) acc.push(p);
	}
}

function isSource(name: string, path: string): boolean {
	if (shouldSkipByPath(path)) return false;
	return SOURCE_EXTS.has(extname(name).toLowerCase());
}

/** Analyze all source files in the given directory. */
export async function analyzeCwd(
	cwd: string = process.cwd(),
	maxFiles = 500,
): Promise<CwdAnalysis> {
	const start = performance.now();
	const files = collectSourceFiles(cwd, maxFiles);
	const results = await phaseNative(files);
	phaseAst(results);
	await phaseSemantic(results);
	await phaseLint(results);
	return summarize(results, start);
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

/** Phase 1.75: Semantic analysis (type checkers). */
async function phaseSemantic(results: FileAnalysis[]): Promise<void> {
  const candidates = results
    .filter((r) => !r.error)
    .map((r) => ({ path: r.filePath, content: readSafe(r.filePath) ?? "" }))
    .filter((f) => !shouldSkipAnalysis(f.content));
  if (candidates.length === 0) return;

  try {
    const semanticResults = await runSemanticAnalysis(candidates);
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
async function phaseLint(results: FileAnalysis[]): Promise<void> {
	const candidates = results
		.filter((r) => !r.error)
		.map((r) => ({ filePath: r.filePath, content: readSafe(r.filePath) ?? "" }))
		.filter((f) => !shouldSkipAnalysis(f.content));
	if (candidates.length === 0) return;
	const runner = await LinterRunner.create();
	const map = await runner.lintFiles(candidates);
	for (const r of results) {
		const lints = map.get(r.filePath);
		if (lints) r.lints = lints;
	}
}

/** Build the summary struct. */
function summarize(results: FileAnalysis[], start: number): CwdAnalysis {
	return {
		files: results,
		totalFiles: results.length,
		totalRules: sum(results, (r) => r.rules.length),
		totalLints: sum(results, (r) => r.lints.flatMap((l) => l.diagnostics).length),
		durationMs: Math.round(performance.now() - start),
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
function highestSeverity(file: FileAnalysis): string {
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
	lines.push("");
	const groups = { error: [], warning: [], info: [], clean: [] };
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

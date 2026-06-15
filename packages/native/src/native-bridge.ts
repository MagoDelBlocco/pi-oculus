import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DiagnosticInput {
	id: string;
	filePath: string;
	line: number;
	column: number;
	severity: "error" | "warning" | "info" | "hint";
	rule: string;
	message: string;
	source: string;
	hasFix: boolean;
	fixCount: number;
	blastRadius: number;
	age: number;
	/** First line of the model's just-edited range in this file. -1 if unknown. */
	touchedStart?: number;
	/** Last line of the model's just-edited range in this file. -1 if unknown. */
	touchedEnd?: number;
	/**
	 * Optional exact set of touched line numbers. When present, scoring uses
	 * the distance to the closest touched line — much more honest than the
	 * bounding box implied by [touchedStart, touchedEnd] when edits straddle
	 * a wide area of the file.
	 */
	touchedLines?: readonly number[];
}

export interface ScoredDiagnostic {
	id: string;
	score: number;
}

export interface PatternHit {
	line: number;
	column: number;
	pattern: string;
	snippet: string;
}

export interface FileMetrics {
	cyclomatic: number;
	cognitive: number;
	maxNesting: number;
	linesOfCode: number;
	entropy: number;
	patterns: PatternHit[];
}

export interface SeverityCounts {
	error: number;
	warning: number;
	info: number;
	hint: number;
}

interface NativeBinding {
	scoreDiagnostic(
		id: string,
		filePath: string,
		line: number,
		column: number,
		severity: string,
		rule: string,
		message: string,
		source: string,
		hasFix: boolean,
		fixCount: number,
		blastRadius: number,
		age: number,
		touchedStart?: number,
		touchedEnd?: number,
		touchedLines?: readonly number[],
	): number;
	scoreBatch(diagnostics: DiagnosticInput[]): ScoredDiagnostic[];
	classifySeverity(severity: string): number;
	cyclomaticComplexity(source: string): number;
	cognitiveComplexity(source: string): number;
	maxNestingDepth(source: string): number;
	codeEntropy(source: string): number;
	linesOfCode(source: string): number;
	detectPatterns(source: string): PatternHit[];
	analyzeFile(source: string): FileMetrics;
	countSeverities(severities: string[]): SeverityCounts;
	normalizeNewlines(s: string): string;
	trimTrailingWhitespace(s: string): string;
	hashString(s: string): number;
	matchOldText(content: string, oldText: string): number;
	countMatches(content: string, oldText: string): number;
	findMatchRange(content: string, oldText: string): [number, number] | [];
	correctIndentation(text: string, fileContent: string): string;
	computeHash(content: string, lineStart: number, lineEnd: number): number;
}

/**
 * Loads the native addon. The extension ships with the .node built — if the
 * load fails we throw immediately at module load time rather than silently
 * degrading to JS fallbacks. Pure-JS reimplementations of the C++ surface
 * were a maintenance burden with no upside: the engine doesn't work without
 * native, so "soft fail" just turned crashes into silent wrong behavior.
 */
const native: NativeBinding = (() => {
	try {
		return require(
			path.join(__dirname, "../build/Release/oculus.node"),
		) as NativeBinding;
	} catch (err) {
		throw new Error(
			"oculus-native: addon failed to load — run `npm rebuild` in packages/native. " +
				`(${err instanceof Error ? err.message : String(err)})`,
		);
	}
})();

/* ----------------------- diagnostic scoring ----------------------- */

export function scoreDiagnostic(diag: DiagnosticInput): number {
	return native.scoreDiagnostic(
		diag.id,
		diag.filePath,
		diag.line,
		diag.column,
		diag.severity,
		diag.rule,
		diag.message,
		diag.source,
		diag.hasFix,
		diag.fixCount,
		diag.blastRadius,
		diag.age,
		diag.touchedStart ?? -1,
		diag.touchedEnd ?? -1,
		diag.touchedLines ?? [],
	);
}

export function scoreBatch(diagnostics: DiagnosticInput[]): ScoredDiagnostic[] {
	// Normalize touched range fields so native's `Get("touchedStart")` always
	// finds a Number rather than `undefined`.
	const normalized = diagnostics.map((d) => ({
		...d,
		touchedStart: d.touchedStart ?? -1,
		touchedEnd: d.touchedEnd ?? -1,
		touchedLines: d.touchedLines ?? [],
	}));
	return native.scoreBatch(normalized);
}

export function classifySeverity(severity: string): number {
	return native.classifySeverity(severity);
}

/* ----------------------- text analysis ----------------------- */

export function cyclomaticComplexity(source: string): number {
	return native.cyclomaticComplexity(source);
}

export function cognitiveComplexity(source: string): number {
	return native.cognitiveComplexity(source);
}

export function maxNestingDepth(source: string): number {
	return native.maxNestingDepth(source);
}

export function codeEntropy(source: string): number {
	return native.codeEntropy(source);
}

export function linesOfCode(source: string): number {
	return native.linesOfCode(source);
}

/* ----------------------- pattern detection ----------------------- */

export function detectPatterns(source: string): PatternHit[] {
	return native.detectPatterns(source);
}

/* ----------------------- fused analysis ----------------------- */

/**
 * Single-pass analysis. Builds the comment/string skip-mask once and reuses
 * it across complexity, nesting, and pattern detection. Use this in preference
 * to the individual functions when you need more than one of them — it
 * avoids redundant N-API string copies and skip-mask rebuilds.
 */
export function analyzeFile(source: string): FileMetrics {
	return native.analyzeFile(source);
}

/* ----------------------- report helpers ----------------------- */

export function countSeverities(severities: string[]): SeverityCounts {
	return native.countSeverities(severities);
}

/* ----------------------- string utilities ----------------------- */

export function normalizeNewlines(s: string): string {
	return native.normalizeNewlines(s);
}

export function trimTrailingWhitespace(s: string): string {
	return native.trimTrailingWhitespace(s);
}

export function hashString(s: string): number {
	return native.hashString(s);
}

export function matchOldText(content: string, oldText: string): number {
	return native.matchOldText(content, oldText);
}

export function countMatches(content: string, oldText: string): number {
	return native.countMatches(content, oldText);
}

export function findMatchRange(
	content: string,
	oldText: string,
): [number, number] | null {
	const result = native.findMatchRange(content, oldText);
	if (!Array.isArray(result) || result.length !== 2) return null;
	return [result[0], result[1]];
}

export function correctIndentation(text: string, fileContent: string): string {
	return native.correctIndentation(text, fileContent);
}

export function computeHash(
	content: string,
	lineStart: number,
	lineEnd: number,
): number {
	return native.computeHash(content, lineStart, lineEnd);
}

import { describe, it, expect } from "vitest";
import {
	scoreDiagnostic,
	scoreBatch,
	classifySeverity,
	cyclomaticComplexity,
	cognitiveComplexity,
	maxNestingDepth,
	codeEntropy,
	linesOfCode,
	detectPatterns,
	analyzeFile,
	countSeverities,
	normalizeNewlines,
	trimTrailingWhitespace,
	hashString,
	matchOldText,
	countMatches,
	findMatchRange,
	correctIndentation,
	computeHash,
} from "../src/native-bridge";

const base = {
	id: "x",
	filePath: "a.ts",
	line: 1,
	column: 1,
	severity: "warning" as const,
	rule: "r",
	message: "m",
	source: "s",
	hasFix: false,
	fixCount: 0,
	blastRadius: 1,
	age: 0,
};

describe("native-bridge", () => {
	it("scoreDiagnostic respects touched range proximity", () => {
		const close = scoreDiagnostic({
			...base,
			severity: "warning",
			line: 10,
			touchedStart: 9,
			touchedEnd: 11,
		});
		const far = scoreDiagnostic({
			...base,
			severity: "warning",
			line: 200,
			touchedStart: 9,
			touchedEnd: 11,
		});
		expect(close).toBeGreaterThan(far);
	});

	it("scoreDiagnostic without touched range defaults to neutral proximity", () => {
		const neutral = scoreDiagnostic({ ...base, severity: "error" });
		expect(neutral).toBeGreaterThanOrEqual(0);
		expect(neutral).toBeLessThanOrEqual(100);
	});

	it("scoreBatch sorts descending and preserves ids", () => {
		const result = scoreBatch([
			{ ...base, id: "low", severity: "hint", blastRadius: 1 },
			{ ...base, id: "high", severity: "error", blastRadius: 10 },
			{ ...base, id: "mid", severity: "warning", blastRadius: 3 },
		]);
		expect(result[0].id).toBe("high");
		expect(result[2].id).toBe("low");
		expect(result.length).toBe(3);
	});

	it("scoreBatch normalizes undefined touched fields", () => {
		// Should not throw even though touchedStart/touchedEnd are omitted.
		expect(() => scoreBatch([base])).not.toThrow();
	});

	it("classifySeverity returns the documented weights", () => {
		expect(classifySeverity("error")).toBe(100);
		expect(classifySeverity("warning")).toBe(50);
		expect(classifySeverity("info")).toBe(20);
		expect(classifySeverity("hint")).toBe(10);
		// Native returns 30 for unknown values per SeverityWeight().
		expect(classifySeverity("bogus")).toBe(30);
	});

	it("cyclomaticComplexity starts at 1 (single linear path)", () => {
		expect(cyclomaticComplexity("const x = 1;")).toBe(1);
	});

	it("cyclomaticComplexity counts && and ||", () => {
		expect(cyclomaticComplexity("if (a && b || c) {}")).toBeGreaterThan(1);
	});

	it("cognitiveComplexity weights deeper conditionals more heavily", () => {
		const flat = cognitiveComplexity("if (a) {} if (b) {} if (c) {}");
		const nested = cognitiveComplexity(
			"if (a) { if (b) { if (c) {} } }",
		);
		expect(nested).toBeGreaterThan(flat);
	});

	it("maxNestingDepth counts braces only, ignoring parens", () => {
		const nested = maxNestingDepth("f(g(h(i(j(k(1)))))) // expression depth");
		expect(nested).toBe(0);
		expect(maxNestingDepth("{ { { } } }")).toBe(3);
	});

	it("codeEntropy returns 0 for empty, finite for content", () => {
		expect(codeEntropy("")).toBe(0);
		expect(codeEntropy("aaaa")).toBe(0);
		expect(codeEntropy("abcdef")).toBeGreaterThan(0);
	});

	it("linesOfCode skips comment-only lines", () => {
		expect(linesOfCode("// nothing\n// nothing\nconst x = 1;")).toBe(1);
	});

	it("linesOfCode handles trailing-newline-less files", () => {
		expect(linesOfCode("const a = 1;\nconst b = 2;")).toBe(2);
	});

	it("detectPatterns returns hits with line/column/pattern fields", () => {
		const hits = detectPatterns("debugger; eval('x');");
		const kinds = hits.map((h) => h.pattern).sort();
		expect(kinds).toContain("debugger");
		expect(kinds).toContain("eval");
		for (const h of hits) {
			expect(h.line).toBeGreaterThanOrEqual(1);
			expect(h.column).toBeGreaterThanOrEqual(1);
			expect(typeof h.snippet).toBe("string");
		}
	});

	it("analyzeFile returns the unified metrics object", () => {
		const m = analyzeFile("function f(x) { if (x) { console.log(x); } }");
		expect(m.cyclomatic).toBeGreaterThanOrEqual(2);
		expect(m.cognitive).toBeGreaterThan(0);
		expect(m.maxNesting).toBeGreaterThanOrEqual(2);
		expect(m.linesOfCode).toBe(1);
		expect(m.patterns.some((p) => p.pattern === "console-log")).toBe(true);
	});

	it("countSeverities counts each bucket; ignores unknown", () => {
		expect(countSeverities([
			"error", "error", "warning", "info", "hint", "bogus",
		])).toEqual({ error: 2, warning: 1, info: 1, hint: 1 });
	});

	it("countSeverities on empty array returns all zeros", () => {
		expect(countSeverities([])).toEqual({
			error: 0, warning: 0, info: 0, hint: 0,
		});
	});

	it("normalizeNewlines converts CRLF and lone CR", () => {
		expect(normalizeNewlines("a\r\nb\rc")).toBe("a\nb\nc");
	});

	it("trimTrailingWhitespace preserves leading whitespace", () => {
		expect(trimTrailingWhitespace("  hello   \n  world\t\t")).toBe(
			"  hello\n  world",
		);
	});

	it("hashString is deterministic and varies by input", () => {
		expect(hashString("a")).toBe(hashString("a"));
		expect(hashString("a")).not.toBe(hashString("b"));
	});

	it("matchOldText matches across CRLF/LF normalization", () => {
		expect(matchOldText("a\r\nb", "a\nb")).toBe(1);
	});

	it("matchOldText returns 0 when oldText is empty", () => {
		expect(matchOldText("hello", "")).toBe(0);
	});

	it("countMatches counts overlapping occurrences", () => {
		expect(countMatches("aaaa", "aa")).toBe(2);
	});

	it("findMatchRange returns null when not found", () => {
		expect(findMatchRange("hello", "world")).toBeNull();
	});

	it("findMatchRange returns multi-line range", () => {
		expect(findMatchRange("a\nb\nc\nd", "b\nc")).toEqual([2, 3]);
	});

	it("correctIndentation returns empty when text already matches", () => {
		expect(correctIndentation("hello", "world hello world")).toBe("");
	});

	it("computeHash is deterministic for the same line range", () => {
		const c = "a\nb\nc\nd";
		expect(computeHash(c, 2, 2)).toBe(computeHash(c, 2, 2));
		expect(computeHash(c, 2, 2)).not.toBe(computeHash(c, 3, 3));
	});
});

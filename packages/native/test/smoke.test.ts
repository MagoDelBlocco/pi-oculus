import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const native = require(path.join(__dirname, "../build/Release/oculus.node"));

describe("Native addon smoke tests", () => {
	it("matchOldText counts occurrences", () => {
		const content = "hello world\nhello universe\nhello world";
		const oldText = "hello world";
		expect(native.matchOldText(content, oldText)).toBe(2);
	});

	it("matchOldText returns 0 for empty oldText", () => {
		expect(native.matchOldText("hello", "")).toBe(0);
	});

	it("countMatches matches count", () => {
		expect(native.countMatches("a b a c a", "a")).toBe(3);
	});

	it("findMatchRange returns correct range", () => {
		const result = native.findMatchRange("line1\nline2\nline3", "line2");
		expect(result).toEqual([2, 2]);
	});

	it("findMatchRange returns empty for no match", () => {
		const result = native.findMatchRange("hello", "world");
		expect(result).toEqual([]);
	});

	it("correctIndentation handles tab to space conversion", () => {
		const text = "\tif (x) {\n\t\treturn 1;\n\t}";
		const fileContent = "  if (x) {\n    return 1;\n  }";
		const result = native.correctIndentation(text, fileContent);
		expect(result).toContain("  if");
	});

	it("computeHash produces consistent hashes", () => {
		const content = "hello world";
		const hash1 = native.computeHash(content, 1, 1);
		const hash2 = native.computeHash(content, 1, 1);
		expect(hash1).toBe(hash2);
	});

	it("scoreDiagnostic returns 0-100 range", () => {
		const diag = {
			id: "test-1",
			filePath: "src/test",
			line: 10,
			column: 5,
			severity: "error",
			rule: "test",
			message: "test message",
			source: "test",
			hasFix: true,
			fixCount: 1,
			blastRadius: 5,
			age: 0,
		};
		const score = native.scoreDiagnostic(
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
		);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(100);
	});

	it("scoreBatch returns sorted results", () => {
		const diagnostics = [
			{
				id: "a",
				severity: "hint",
				line: 1,
				blastRadius: 1,
				hasFix: false,
				fixCount: 0,
				age: 0,
				filePath: "",
				column: 0,
				rule: "",
				message: "",
				source: "",
			},
			{
				id: "b",
				severity: "error",
				line: 1,
				blastRadius: 10,
				hasFix: true,
				fixCount: 2,
				age: 0,
				filePath: "",
				column: 0,
				rule: "",
				message: "",
				source: "",
			},
		];
		const results = native.scoreBatch(diagnostics);
		expect(results[0].id).toBe("b");
		expect(results[1].id).toBe("a");
	});

	it("classifySeverity returns weights", () => {
		expect(native.classifySeverity("error")).toBe(100);
		expect(native.classifySeverity("warning")).toBe(50);
		expect(native.classifySeverity("info")).toBe(20);
		expect(native.classifySeverity("hint")).toBe(10);
	});

	it("cyclomaticComplexity counts branches", () => {
		const simple = "if (x) { return 1; } else { return 2; }";
		expect(native.cyclomaticComplexity(simple)).toBeGreaterThanOrEqual(2);
	});

	it("maxNestingDepth measures brace depth", () => {
		const nested = "if (x) { while (y) { if (z) { } } }";
		expect(native.maxNestingDepth(nested)).toBe(3);
	});

	it("codeEntropy returns 0 for empty string", () => {
		expect(native.codeEntropy("")).toBe(0);
	});

	it("normalizeNewlines converts CRLF to LF", () => {
		expect(native.normalizeNewlines("hello\r\nworld")).toBe("hello\nworld");
	});

	it("trimTrailingWhitespace removes trailing spaces", () => {
		expect(native.trimTrailingWhitespace("hello   \nworld  ")).toBe(
			"hello\nworld",
		);
	});

	it("hashString produces consistent hashes", () => {
		expect(native.hashString("hello")).toBe(native.hashString("hello"));
	});

	it("linesOfCode counts non-empty non-comment lines", () => {
		const src = [
			"// header comment",
			"const x = 1;",
			"",
			"function f() {",
			"  return x;",
			"}",
		].join("\n");
		expect(native.linesOfCode(src)).toBe(4);
	});

	it("analyzeFile returns combined metrics in one call", () => {
		const src = "function f() { if (x) { console.log('hi'); debugger; } }";
		const m = native.analyzeFile(src);
		expect(m.cyclomatic).toBeGreaterThanOrEqual(2);
		expect(m.cognitive).toBeGreaterThan(0);
		expect(m.maxNesting).toBeGreaterThanOrEqual(2);
		expect(m.entropy).toBeGreaterThan(0);
		expect(m.linesOfCode).toBe(1);
		const ids = m.patterns.map((p: { pattern: string }) => p.pattern).sort();
		expect(ids).toContain("console-log");
		expect(ids).toContain("debugger");
	});

	it("analyzeFile ignores keywords inside strings and comments", () => {
		const inert = '// if (x) while (y) for (;;) {}\nconst s = "if (a) { while (b) {} }";';
		const m = native.analyzeFile(inert);
		expect(m.cyclomatic).toBe(1); // base path only
		expect(m.cognitive).toBe(0);
		expect(m.maxNesting).toBe(0);
		expect(m.patterns.length).toBe(0);
	});

	it("analyzeFile handles empty source", () => {
		const m = native.analyzeFile("");
		expect(m.cyclomatic).toBe(1);
		expect(m.cognitive).toBe(0);
		expect(m.maxNesting).toBe(0);
		expect(m.linesOfCode).toBe(0);
		expect(m.entropy).toBe(0);
		expect(m.patterns).toEqual([]);
	});

	it("detectPatterns ignores eval inside a comment", () => {
		const hits = native.detectPatterns("// eval(x)\nconst x = 1;");
		expect(hits.length).toBe(0);
	});

	it("detectPatterns ignores debugger inside a string literal", () => {
		const hits = native.detectPatterns('const s = "debugger;";');
		expect(hits.length).toBe(0);
	});

	it("detectPatterns flags eval()", () => {
		const hits = native.detectPatterns("const y = eval('1');");
		expect(hits.some((h: { pattern: string }) => h.pattern === "eval")).toBe(true);
	});

	it("detectPatterns does not flag bare 'eval' identifier without parens", () => {
		const hits = native.detectPatterns("const ev = eval;");
		expect(hits.some((h: { pattern: string }) => h.pattern === "eval")).toBe(
			false,
		);
	});

	it("detectPatterns flags only console.{log,warn,error,info,debug}, not arbitrary props", () => {
		const hits = native.detectPatterns(
			"console.log('a'); console.foo('b'); console.warn('c');",
		);
		const kinds = hits
			.filter((h: { pattern: string }) => h.pattern === "console-log")
			.map((h: { line: number; column: number }) => `${h.line}:${h.column}`);
		// Two hits — log and warn. The console.foo one must not be reported.
		expect(kinds.length).toBe(2);
	});

	it("detectPatterns identifies empty catch{} but not catch with code", () => {
		const empty = native.detectPatterns("try { f(); } catch (e) {}");
		expect(empty.some((h: { pattern: string }) => h.pattern === "empty-catch"))
			.toBe(true);
		const populated = native.detectPatterns(
			"try { f(); } catch (e) { log(e); }",
		);
		expect(
			populated.some((h: { pattern: string }) => h.pattern === "empty-catch"),
		).toBe(false);
	});

	it("detectPatterns hardcoded-secret needs an 8+ char literal", () => {
		// Short literal — not flagged.
		expect(
			native.detectPatterns('const password = "short";'),
		).toEqual([]);
		// Long literal — flagged.
		const long = native.detectPatterns(
			'const password = "averyverylongsecret";',
		);
		expect(
			long.some((h: { pattern: string }) => h.pattern === "hardcoded-secret"),
		).toBe(true);
	});

	it("detectPatterns hardcoded-secret rejects identifiers containing the trigger word", () => {
		// `notpassword` should not match because of the alpha char before "password".
		expect(
			native.detectPatterns(
				'const notpassword = "averyverylongstring";',
			),
		).toEqual([]);
	});

	it("detectPatterns flags alert() but not bare 'alert'", () => {
		expect(
			native.detectPatterns("alert('hi');").some(
				(h: { pattern: string }) => h.pattern === "alert",
			),
		).toBe(true);
		expect(
			native.detectPatterns("const a = alert;").some(
				(h: { pattern: string }) => h.pattern === "alert",
			),
		).toBe(false);
	});

	it("detectPatterns line/column are 1-indexed", () => {
		const hits = native.detectPatterns("\n\ndebugger;");
		const dbg = hits.find((h: { pattern: string }) => h.pattern === "debugger");
		expect(dbg.line).toBe(3);
		expect(dbg.column).toBe(1);
	});

	it("countSeverities counts buckets via native", () => {
		const counts = native.countSeverities(["error", "warning", "warning", "info"]);
		expect(counts).toEqual({ error: 1, warning: 2, info: 1, hint: 0 });
	});

	it("countSeverities ignores unknown severities", () => {
		const counts = native.countSeverities(["bogus", "error"]);
		expect(counts).toEqual({ error: 1, warning: 0, info: 0, hint: 0 });
	});

	it("classifySeverity returns 30 for unknown", () => {
		expect(native.classifySeverity("bogus")).toBe(30);
	});

	it("cyclomaticComplexity baseline is 1 for trivial code", () => {
		expect(native.cyclomaticComplexity("const x = 1;")).toBe(1);
	});

	it("cognitiveComplexity escalates with nesting", () => {
		const flat = native.cognitiveComplexity("if (a) {} if (b) {} if (c) {}");
		const nested = native.cognitiveComplexity(
			"if (a) { if (b) { if (c) {} } }",
		);
		expect(nested).toBeGreaterThan(flat);
	});

	it("maxNestingDepth ignores parens and brackets", () => {
		expect(native.maxNestingDepth("f(g(h(i())))")).toBe(0);
		expect(native.maxNestingDepth("[[[[1]]]]")).toBe(0);
		expect(native.maxNestingDepth("{}{}{}")).toBe(1);
	});

	it("codeEntropy is ~0 for repeating characters", () => {
		expect(native.codeEntropy("aaaa")).toBe(0);
	});

	it("scoreDiagnostic proximity term: line in touched range > line outside", () => {
		const args = (line: number, ts: number, te: number) => [
			"id",
			"a.ts",
			line,
			0,
			"warning",
			"r",
			"m",
			"s",
			false,
			0,
			1,
			0,
			ts,
			te,
		] as const;
		const inside = native.scoreDiagnostic(...args(10, 5, 15));
		const outside = native.scoreDiagnostic(...args(200, 5, 15));
		expect(inside).toBeGreaterThan(outside);
	});

	it("scoreDiagnostic with touchedLines uses distance to NEAREST line, not bounding box", () => {
		// Diagnostic at line 250. Edits at lines 5 and 500. The bounding box
		// would think 250 is inside the touched range (high proximity); the
		// set-aware path correctly treats it as 245 lines away (≈0 proximity).
		const fn = (lines: number[]) =>
			native.scoreDiagnostic(
				"id",
				"a.ts",
				250,
				0,
				"warning",
				"r",
				"m",
				"s",
				false,
				0,
				1,
				0,
				Math.min(...lines),
				Math.max(...lines),
				lines,
			);
		const setBased = fn([5, 500]);
		const close = fn([249, 250, 251]);
		expect(close).toBeGreaterThan(setBased);
	});

	it("findMatchRange empty array when no match", () => {
		expect(native.findMatchRange("abc", "z")).toEqual([]);
	});

	it("cyclomaticComplexity does NOT count optional chaining as a branch", () => {
		// `obj?.foo?.bar?.baz` has three `?` characters but zero branches.
		expect(native.cyclomaticComplexity("obj?.foo?.bar?.baz")).toBe(1);
	});

	it("cyclomaticComplexity does NOT count nullish coalescing as a branch", () => {
		expect(native.cyclomaticComplexity("const x = a ?? b ?? c;")).toBe(1);
	});

	it("cyclomaticComplexity still counts ternary `?`", () => {
		expect(native.cyclomaticComplexity("const x = a ? b : c;")).toBe(2);
	});

	it("detectPatterns does NOT flag .eval() method calls", () => {
		const hits = native.detectPatterns(
			"ctx.eval(x); obj.eval('y'); arr?.eval(z);",
		);
		expect(hits.filter((h: { pattern: string }) => h.pattern === "eval"))
			.toEqual([]);
	});

	it("detectPatterns still flags global eval()", () => {
		const hits = native.detectPatterns("eval('x');");
		expect(hits.some((h: { pattern: string }) => h.pattern === "eval")).toBe(
			true,
		);
	});

	it("detectPatterns does NOT flag .alert() method calls", () => {
		const hits = native.detectPatterns(
			"dialog.alert('hi'); notifier?.alert('x');",
		);
		expect(hits.filter((h: { pattern: string }) => h.pattern === "alert"))
			.toEqual([]);
	});

	it("findMatchRange handles trailing-whitespace tolerance in oldText", () => {
		// The trim guards against formatters that strip trailing spaces from the
		// model's old text.
		expect(native.findMatchRange("a\nb\nc", "b   ")).toEqual([2, 2]);
	});

	it("computeHash differs by range", () => {
		const c = "a\nb\nc";
		expect(native.computeHash(c, 1, 1)).not.toBe(native.computeHash(c, 2, 2));
	});
});

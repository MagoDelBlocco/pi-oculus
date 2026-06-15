import { describe, it, expect } from "vitest";
import { runRules, runRulesFromMetrics, runAllRules } from "../src/index";
import { analyzeFile } from "../../native/src/native-bridge";

describe("runRules (native-backed)", () => {
	it("detects eval", () => {
		const matches = runRules("a.ts", "const x = eval('1+1');");
		expect(matches.some((m) => m.rule === "oculus/eval-detected")).toBe(true);
	});

	it("detects debugger", () => {
		const matches = runRules("a.ts", "function f() { debugger; }");
		expect(matches.some((m) => m.rule === "oculus/debugger-statement")).toBe(
			true,
		);
	});

	it("detects console.log", () => {
		const matches = runRules("a.ts", "console.log('hi');");
		expect(matches.some((m) => m.rule === "oculus/console-log")).toBe(true);
	});

	it("detects empty catch", () => {
		const matches = runRules(
			"a.ts",
			"try { foo(); } catch (e) { }",
		);
		expect(matches.some((m) => m.rule === "oculus/error-swallowing")).toBe(
			true,
		);
	});

	it("detects hardcoded secret", () => {
		const matches = runRules(
			"a.ts",
			'const api_key = "supersecretkey123";',
		);
		expect(matches.some((m) => m.rule === "oculus/hardcoded-secret")).toBe(
			true,
		);
	});

	it("ignores patterns inside comments", () => {
		const matches = runRules("a.ts", "// eval is bad\nconst x = 1;");
		expect(matches.length).toBe(0);
	});

	it("ignores patterns inside strings", () => {
		const matches = runRules("a.ts", 'const x = "console.log";');
		expect(matches.length).toBe(0);
	});

	it("flags high complexity", () => {
		const src = Array.from({ length: 20 }, (_, i) => `if (x${i}) { }`).join(
			"\n",
		);
		const matches = runRules("a.ts", src);
		expect(matches.some((m) => m.rule === "oculus/high-complexity")).toBe(true);
	});

	it("returns empty for clean code", () => {
		const matches = runRules("a.ts", "export const greet = () => 1;");
		expect(matches.length).toBe(0);
	});

	it("detects empty alert()", () => {
		const matches = runRules("a.ts", "alert('hi');");
		expect(matches.some((m) => m.rule === "oculus/no-alert")).toBe(true);
	});

	it("includes a stable id with file:line:column", () => {
		const matches = runRules("a.ts", "\ndebugger;");
		const dbg = matches.find((m) => m.rule === "oculus/debugger-statement");
		expect(dbg?.id).toBe("oculus/debugger-statement:a.ts:2:1");
	});

	it("flags high cognitive complexity above the error threshold", () => {
		// 60+ cognitive points via deep nested branching.
		const src = `function f() {
${Array.from({ length: 6 }, (_, i) => "  if (a) { if (b) { if (c) { if (d) {} } } }").join("\n")}
}`;
		const matches = runRules("a.ts", src);
		expect(
			matches.some(
				(m) =>
					m.rule === "oculus/high-cognitive-complexity" &&
					m.severity === "error",
			),
		).toBe(true);
	});

	it("flags warning-band cognitive complexity (>= threshold, < error threshold)", () => {
		// Cognitive complexity weights each branching keyword by (1 + nesting).
		// 7-level nested ifs ⇒ 1+2+3+4+5+6+7 = 28, in the warning band [25, 50].
		const matches = runRules(
			"a.ts",
			"function f() { if (a) { if (b) { if (c) { if (d) { if (e) { if (f) { if (g) {} } } } } } } }",
		);
		expect(
			matches.some(
				(m) =>
					m.rule === "oculus/high-cognitive-complexity" &&
					m.severity === "warning",
			),
		).toBe(true);
	});

	it("flags error-band cyclomatic complexity (>40)", () => {
		const src = Array.from({ length: 50 }, (_, i) => `if (x${i}) {}`).join(
			"\n",
		);
		const matches = runRules("a.ts", src);
		expect(
			matches.some(
				(m) => m.rule === "oculus/high-complexity" && m.severity === "error",
			),
		).toBe(true);
	});

	it("respects a custom threshold parameter", () => {
		const matches = runRules(
			"a.ts",
			"if (a) {} if (b) {}",
			{
				cyclomatic: 1,
				cognitive: 100,
				cyclomaticError: 100,
				cognitiveError: 100,
			},
		);
		expect(
			matches.some(
				(m) =>
					m.rule === "oculus/high-complexity" && m.severity === "warning",
			),
		).toBe(true);
	});

	it("runRulesFromMetrics works against pre-computed metrics", () => {
		const m = analyzeFile("debugger;\nconsole.log('x');");
		const matches = runRulesFromMetrics("a.ts", m);
		const rules = matches.map((x) => x.rule).sort();
		expect(rules).toContain("oculus/debugger-statement");
		expect(rules).toContain("oculus/console-log");
	});

	it("runAllRules is an async wrapper that returns the same data", async () => {
		const sync = runRules("a.ts", "debugger;");
		const asyncResult = await runAllRules("a.ts", "debugger;");
		expect(asyncResult.map((r) => r.rule)).toEqual(sync.map((r) => r.rule));
	});

	it("pattern matches carry line/column matching native output", () => {
		const matches = runRules("a.ts", "  debugger;");
		const dbg = matches.find((m) => m.rule === "oculus/debugger-statement");
		expect(dbg?.line).toBe(1);
		expect(dbg?.column).toBe(3);
	});
});

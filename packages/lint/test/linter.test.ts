import { describe, it, expect } from "vitest";
import {
	createLinterRunner,
	LinterRunner,
	linterApplies,
	parseEslintJson,
	parseGenericText,
	parseGenericJson,
	mapSeverity,
	scoreLintResult,
} from "../src/index";

describe("LinterRunner", () => {
	it("createLinterRunner returns instance", () => {
		const runner = createLinterRunner();
		expect(runner).toBeDefined();
	});

	it("parseGenericText extracts diagnostics", () => {
		const output = "1:2 error Missing semicolon\n3:1 warning Unused variable";
		const diagnostics = parseGenericText("test", output, "test");
		expect(diagnostics.length).toBe(2);
		expect(diagnostics[0].line).toBe(1);
		expect(diagnostics[0].column).toBe(2);
		expect(diagnostics[0].severity).toBe("error");
	});

	it("mapSeverity normalizes strings", () => {
		expect(mapSeverity("error")).toBe("error");
		expect(mapSeverity("fatal")).toBe("error");
		expect(mapSeverity("warn")).toBe("warning");
		expect(mapSeverity("hint")).toBe("hint");
		expect(mapSeverity("unknown")).toBe("info");
	});
});

describe("parseEslintJson", () => {
	it("parses eslint JSON output", () => {
		const output = JSON.stringify([
			{
				messages: [
					{
						ruleId: "semi",
						message: "missing",
						severity: 2,
						line: 1,
						column: 1,
					},
				],
			},
		]);
		const diagnostics = parseEslintJson("test", output);
		expect(diagnostics[0].rule).toBe("semi");
		expect(diagnostics[0].severity).toBe("error");
		expect(diagnostics[0].line).toBe(1);
	});

	it("returns empty on invalid JSON", () => {
		expect(parseEslintJson("test", "not json")).toEqual([]);
	});

	it("marks hasFix when fix metadata is present", () => {
		const output = JSON.stringify([
			{
				messages: [
					{
						ruleId: "semi",
						message: "missing",
						severity: 1,
						line: 1,
						column: 1,
						fix: { range: [0, 1], text: ";" },
					},
				],
			},
		]);
		const d = parseEslintJson("f", output);
		expect(d[0].hasFix).toBe(true);
		expect(d[0].fixCount).toBe(1);
		expect(d[0].severity).toBe("warning");
	});

	it("substitutes 'unknown' for null ruleId", () => {
		const output = JSON.stringify([
			{
				messages: [
					{ ruleId: null, message: "x", severity: 1, line: 1, column: 1 },
				],
			},
		]);
		const d = parseEslintJson("f", output);
		expect(d[0].rule).toBe("eslint");
		expect(d[0].id).toContain(":unknown");
	});
});

describe("parseGenericJson", () => {
	it("parses the {diagnostics: [...]} shape", () => {
		const output = JSON.stringify({
			diagnostics: [
				{
					line: 4,
					column: 5,
					severity: "error",
					rule: "semi",
					message: "missing",
				},
			],
		});
		const d = parseGenericJson("a.ts", output, "biome");
		expect(d.length).toBe(1);
		expect(d[0].line).toBe(4);
		expect(d[0].severity).toBe("error");
		expect(d[0].source).toBe("biome");
	});

	it("returns [] on malformed JSON", () => {
		expect(parseGenericJson("a.ts", "{not json", "biome")).toEqual([]);
	});

	it("handles array-of-files input shape", () => {
		const output = JSON.stringify([
			{ messages: [{ line: 1, column: 1, message: "m" }] },
		]);
		const d = parseGenericJson("a.ts", output, "x");
		expect(d.length).toBe(1);
		expect(d[0].message).toBe("m");
	});

	it("falls back to unknown rule when missing", () => {
		const output = JSON.stringify({ issues: [{ line: 1, message: "x" }] });
		const d = parseGenericJson("a.ts", output, "x");
		expect(d[0].rule).toBe("x");
	});
});

describe("mapSeverity (extra)", () => {
	it("returns 'warning' for non-string input", () => {
		expect(mapSeverity(undefined)).toBe("warning");
		expect(mapSeverity(2)).toBe("warning");
		expect(mapSeverity(null)).toBe("warning");
	});

	it("is case-insensitive", () => {
		expect(mapSeverity("ERROR")).toBe("error");
		expect(mapSeverity("Warn")).toBe("warning");
	});
});

describe("scoreLintResult", () => {
	it("attaches a score to every diagnostic", () => {
		const result = {
			filePath: "a.ts",
			linter: "eslint",
			diagnostics: [
				{
					id: "1",
					filePath: "a.ts",
					line: 1,
					column: 1,
					severity: "error" as const,
					rule: "r",
					message: "m",
					source: "eslint",
					hasFix: false,
					fixCount: 0,
					blastRadius: 1,
					age: 0,
				},
			],
			output: "",
			durationMs: 0,
		};
		const scored = scoreLintResult(result);
		expect(scored.scoredDiagnostics[0].score).toBeGreaterThanOrEqual(0);
		expect(scored.scoredDiagnostics[0].score).toBeLessThanOrEqual(100);
	});

	it("preserves the original result shape", () => {
		const result = {
			filePath: "a.ts",
			linter: "eslint",
			diagnostics: [],
			output: "",
			durationMs: 5,
		};
		const scored = scoreLintResult(result);
		expect(scored.filePath).toBe("a.ts");
		expect(scored.durationMs).toBe(5);
		expect(scored.scoredDiagnostics).toEqual([]);
	});
});

describe("linterApplies", () => {
	it("returns true when no extensions are configured", () => {
		expect(
			linterApplies(
				{ name: "x", command: "x", args: [], parser: "generic" },
				"f.py",
			),
		).toBe(true);
	});

	it("matches on extension (case-insensitive)", () => {
		const cfg = {
			name: "x",
			command: "x",
			args: [],
			parser: "generic" as const,
			extensions: [".ts"],
		};
		expect(linterApplies(cfg, "src/a.TS")).toBe(true);
		expect(linterApplies(cfg, "src/a.py")).toBe(false);
	});

	it("rejects empty extensions array as 'no filter' (matches anything)", () => {
		expect(
			linterApplies(
				{
					name: "x",
					command: "x",
					args: [],
					parser: "generic",
					extensions: [],
				},
				"any.py",
			),
		).toBe(true);
	});
});

describe("LinterRunner (config / no-spawn)", () => {
	it("skips disabled linters", async () => {
		// Use a fake "linter" that's disabled and would otherwise blow up.
		const runner = new LinterRunner(
			[
				{
					name: "fake",
					command: "/bin/false",
					args: [],
					parser: "generic",
					enabled: false,
				},
			],
			10,
		);
		const out = await runner.lintFile("a.ts", "x");
		expect(out).toEqual([]);
	});

	it("returns one LintResult per enabled linter (even on failure)", async () => {
		// 1ms timeout guarantees fast failure without needing real linters installed.
		const runner = new LinterRunner(
			[
				{
					name: "fake1",
					command: "sleep",
					args: ["5"],
					parser: "generic",
				},
				{
					name: "fake2",
					command: "sleep",
					args: ["5"],
					parser: "generic",
				},
			],
			1,
		);
		const out = await runner.lintFile("a.ts", "x");
		expect(out.length).toBe(2);
		expect(out[0].linter).toBe("fake1");
		expect(out[1].linter).toBe("fake2");
	});

	it("lintFiles fans out across multiple paths", async () => {
		const runner = new LinterRunner(
			[
				{
					name: "fake",
					command: "sleep",
					args: ["5"],
					parser: "generic",
					enabled: false,
				},
			],
			1,
		);
		const out = await runner.lintFiles([
			{ filePath: "a.ts", content: "x" },
			{ filePath: "b.ts", content: "y" },
		]);
		expect(out.size).toBe(2);
	});

	it("skips linters whose extension allow-list excludes the file", async () => {
		const runner = new LinterRunner(
			[
				{
					name: "ts-only",
					command: "sleep",
					args: ["5"],
					parser: "generic",
					extensions: [".ts"],
				},
			],
			1,
		);
		const out = await runner.lintFile("a.py", "x");
		expect(out).toEqual([]);
	});

	it("runs the linter when the extension matches", async () => {
		const runner = new LinterRunner(
			[
				{
					name: "ts-only",
					command: "sleep",
					args: ["5"],
					parser: "generic",
					extensions: [".ts"],
				},
			],
			1,
		);
		const out = await runner.lintFile("a.ts", "x");
		expect(out.length).toBe(1);
	});
});

describe("parseGenericText (extra)", () => {
	it("ignores lines that don't match the pattern", () => {
		const output = "some unrelated banner\n1:1 error oops\nmore noise";
		const d = parseGenericText("f", output, "x");
		expect(d.length).toBe(1);
		expect(d[0].message).toBe("oops");
	});

	it("handles 'info' and 'hint' severities", () => {
		const output = "1:1 info detail\n2:2 hint suggestion";
		const d = parseGenericText("f", output, "x");
		expect(d[0].severity).toBe("info");
		expect(d[1].severity).toBe("hint");
	});
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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
import { DEFAULT_LINTERS, resolveAvailableLinters } from "../src/linter-defaults";

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
	it("parses Ruff's top-level diagnostic array", () => {
		const output = JSON.stringify([{ code: "F821", message: "Undefined name", location: { row: 3, column: 8 } }]);
		expect(parseGenericJson("x.py", output, "ruff")).toMatchObject([
			{ line: 3, column: 8, rule: "F821", message: "Undefined name" },
		]);
	});

	it("parses Biome's JSON reporter locations", () => {
		const output = JSON.stringify({ diagnostics: [{ category: "lint/suspicious/noDebugger", severity: "error",
			description: "Unexpected debugger", location: { span: [4, 12] } }] });
		expect(parseGenericJson("x.ts", output, "biome", "abc\ndebugger;\n")).toMatchObject([
			{ line: 2, column: 1, severity: "error", rule: "lint/suspicious/noDebugger" },
		]);
	});

	it("parses ShellCheck's top-level array", () => {
		const output = JSON.stringify([{ line: 2, column: 1, level: "warning", code: 2086, message: "Double quote" }]);
		expect(parseGenericJson("x.sh", output, "shellcheck")).toMatchObject([
			{ line: 2, column: 1, severity: "warning", rule: "2086" },
		]);
	});
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

describe("tool execution", () => {
	it("discovers and runs a project-local linter in the requested cwd", async () => {
		const cwd = mkdtempSync(join(process.cwd(), ".oculus-lint-cwd-"));
		try {
			const binDir = join(cwd, "node_modules", ".bin");
			mkdirSync(binDir, { recursive: true });
			writeFileSync(join(binDir, "oculus-test-linter"), "#!/bin/sh\nprintf '1:1 warning from-project\\n'\n", { mode: 0o755 });
			const config = { name: "local", command: "oculus-test-linter", args: [] as string[], parser: "generic" as const };
			expect(await resolveAvailableLinters([config], cwd)).toHaveLength(1);
			const [result] = await new LinterRunner([config], 2000, cwd).lintFile("x.ts", "x");
			expect(result.diagnostics).toMatchObject([{ message: "from-project" }]);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("lets ESLint load the project's configuration", () => {
		const eslint = DEFAULT_LINTERS.find((l) => l.name === "eslint")!;
		expect(eslint.args).not.toContain("--no-config-lookup");
	});

	it("discovers binaries under native ESM", async () => {
		const available = await resolveAvailableLinters([
			{ name: "node", command: process.execPath, args: [], parser: "generic" },
		]);
		expect(available).toHaveLength(1);
	});

	it("reports a formatting failure without positional output", async () => {
		const runner = new LinterRunner([{ name: "formatter", command: process.execPath,
			args: ["-e", "process.exit(1)"], parser: "status", extensions: [".ts"] }]);
		const [result] = await runner.lintFile("x.ts", "let x=1");
		expect(result.diagnostics).toMatchObject([{ rule: "formatter/format", line: 0 }]);
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

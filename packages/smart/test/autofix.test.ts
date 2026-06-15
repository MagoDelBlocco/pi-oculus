import { describe, it, expect } from "vitest";
import { AutofixPipeline, createAutofixPipeline } from "../src/autofix";

describe("AutofixPipeline", () => {
	it("createAutofixPipeline returns an instance", () => {
		expect(createAutofixPipeline()).toBeInstanceOf(AutofixPipeline);
	});

	it("no-op when no fixers are configured", async () => {
		const pipeline = new AutofixPipeline({ fixers: [] });
		const result = await pipeline.apply("a.ts", "const x = 1;");
		expect(result.applied).toBe(false);
		expect(result.before).toBe("const x = 1;");
		expect(result.content).toBe("const x = 1;");
		expect(result.fixers).toEqual([]);
		expect(result.totalChars).toBe(0);
	});

	it("records an outcome per fixer regardless of success", async () => {
		// 1ms timeout guarantees every fixer fails fast without needing npx installed.
		const pipeline = new AutofixPipeline({
			fixers: ["eslint", "prettier"],
			timeoutMs: 1,
		});
		const result = await pipeline.apply("a.ts", "const x=1");
		expect(result.fixers.length).toBe(2);
		expect(result.fixers[0].fixer).toBe("eslint");
		expect(result.fixers[1].fixer).toBe("prettier");
		expect(result.applied).toBe(false);
	});

	it("preserves before content when nothing applied", async () => {
		const pipeline = new AutofixPipeline({ fixers: ["eslint"], timeoutMs: 1 });
		const result = await pipeline.apply("a.ts", "abc");
		expect(result.content).toBe("abc");
		expect(result.before).toBe("abc");
	});

	it("reports outcomes per fixer in order", async () => {
		const pipeline = new AutofixPipeline({
			fixers: ["biome", "prettier", "eslint"],
			timeoutMs: 1,
		});
		const result = await pipeline.apply("a.ts", "x");
		expect(result.fixers.map((f) => f.fixer)).toEqual([
			"biome",
			"prettier",
			"eslint",
		]);
	});

	it("totalChars is 0 when nothing changed", async () => {
		const pipeline = new AutofixPipeline({ fixers: [], timeoutMs: 1 });
		const result = await pipeline.apply("a.ts", "abcdef");
		expect(result.totalChars).toBe(0);
	});

	it("default fixers are eslint and prettier", async () => {
		const pipeline = new AutofixPipeline({ timeoutMs: 1 });
		const result = await pipeline.apply("a.ts", "x");
		expect(result.fixers.map((f) => f.fixer)).toEqual(["eslint", "prettier"]);
	});
});

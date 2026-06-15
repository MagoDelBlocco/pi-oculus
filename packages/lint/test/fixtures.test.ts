import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Lint fixtures", () => {
	const fixturesDir = new URL("fixtures/", import.meta.url).pathname;

	it("broken.ts exists and contains issues", () => {
		const content = readFileSync(`${fixturesDir}/broken.ts`, "utf8");
		expect(content).toContain("console.log");
		expect(content).toContain("var unused");
	});

	it("broken.js exists and contains issues", () => {
		const content = readFileSync(`${fixturesDir}/broken.js`, "utf8");
		expect(content).toContain("console.log");
		expect(content).toContain("var unused");
	});

	it("broken.py exists and contains issues", () => {
		const content = readFileSync(`${fixturesDir}/broken.py`, "utf8");
		expect(content).toContain("import os,sys");
		expect(content).toContain("x=1");
	});
});

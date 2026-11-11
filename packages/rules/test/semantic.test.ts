import { describe, it, expect } from "vitest";
import {
  runTypeChecker,
  runTypeCheckers,
  runSemanticAnalysis,
  resolveAvailableCheckers,
  DEFAULT_CHECKERS,
} from "../src/semantic";
import { parseCargoJson, parseTscOutput } from "../src/semantic/type-checker";
import { resolve } from "node:path";

describe("type checker integration", () => {
  describe("resolveAvailableCheckers", () => {
    it("returns only checkers with available binaries", () => {
      const available = resolveAvailableCheckers();
      expect(available.some((c) => c.name === "tsc")).toBe(true);
    });

    it("filters by enabled flag", () => {
      const checkers = [
        ...DEFAULT_CHECKERS,
        { ...DEFAULT_CHECKERS[0], enabled: false },
      ];
      const available = resolveAvailableCheckers(checkers);
      expect(available.every((c) => c.enabled !== false)).toBe(true);
    });
  });

  describe("DEFAULT_CHECKERS", () => {
    it("includes tsc for TypeScript", () => {
      const tsc = DEFAULT_CHECKERS.find((c) => c.name === "tsc");
      expect(tsc).toBeDefined();
      expect(tsc!.extensions).toContain(".ts");
      expect(tsc!.extensions).toContain(".tsx");
    });

    it("includes mypy for Python", () => {
      const mypy = DEFAULT_CHECKERS.find((c) => c.name === "mypy");
      expect(mypy).toBeDefined();
      expect(mypy!.extensions).toContain(".py");
    });

    it("includes cargo-check for Rust", () => {
      const cargo = DEFAULT_CHECKERS.find((c) => c.name === "cargo-check");
      expect(cargo).toBeDefined();
      expect(cargo!.extensions).toContain(".rs");
    });

    it("includes pyright for Python", () => {
      const pyright = DEFAULT_CHECKERS.find((c) => c.name === "pyright");
      expect(pyright).toBeDefined();
      expect(pyright!.extensions).toContain(".py");
    });
  });

  describe("runTypeChecker", () => {
    it("respects extension gating", () => {
      const tsc = DEFAULT_CHECKERS.find((c) => c.name === "tsc")!;
      const result = runTypeChecker(tsc, {
        path: "test.py",
        content: "print('hello')",
      });
      // tsc should not process .py files
      expect(result).toEqual([]);
    });

    it("returns array for non-existent file", () => {
      const tsc = DEFAULT_CHECKERS.find((c) => c.name === "tsc")!;
      const result = runTypeChecker(tsc, {
        path: "nonexistent.ts",
        content: "const x: string = 42;",
      });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  it("marks a checker that exits without diagnostics as failed", async () => {
    const failed = new Set<string>();
    const file = "/tmp/oculus-checker-failure.ts";
    await runTypeCheckers([{ path: file }], [{
      name: "failing-tsc", command: process.execPath, args: ["-e", "process.exit(2)"],
      format: "tsc", extensions: [".ts"],
    }], 2000, failed);
    expect(failed.has(file)).toBe(true);
  });

  describe("runSemanticAnalysis", () => {
    it("returns a Map", async () => {
      const result = await runSemanticAnalysis([]);
      expect(result instanceof Map).toBe(true);
    });

    it("handles empty input", async () => {
      const result = await runSemanticAnalysis([]);
      expect(result.size).toBe(0);
    });

    it("does not crash on invalid files", async () => {
      const result = await runSemanticAnalysis([
        { path: "test.ts", content: "{{{{invalid" },
      ]);
      expect(result instanceof Map).toBe(true);
    });
  });
});

describe("output parsers", () => {
	 it("parses the location format emitted by tsc", () => {
		const file = resolve("src/example.ts");
		const output = "src/example.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'.";
		expect(parseTscOutput(file, output)).toMatchObject([{ filePath: file, line: 2, column: 7, severity: "error" }]);
		expect(parseTscOutput(resolve("src/other.ts"), output)).toEqual([]);
	});

	it("parses cargo compiler messages for the requested file", () => {
		const file = resolve("src/main.rs");
		const output = JSON.stringify({ reason: "compiler-message", message: {
			message: "unused variable", level: "warning", code: { code: "unused_variables" },
			spans: [{ file_name: "src/main.rs", line_start: 4, column_start: 3 }],
		} });
		expect(parseCargoJson(file, output)).toMatchObject([{ line: 4, column: 3, message: "unused variable" }]);
		expect(parseCargoJson(resolve("src/lib.rs"), output)).toEqual([]);
	});
  // Test the parsers directly by importing them through runTypeChecker
  // Since we can't easily import internal functions, we test through the public API

  it("tsc parser handles empty output", () => {
    const tsc = DEFAULT_CHECKERS.find((c) => c.name === "tsc")!;
    // When tsc has nothing to report, output is empty
    const result = runTypeChecker(tsc, {
      path: "test.ts",
      content: "const x = 1;",
    });
    expect(Array.isArray(result)).toBe(true);
  });
});

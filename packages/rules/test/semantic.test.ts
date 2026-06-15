import { describe, it, expect } from "vitest";
import {
  runTypeChecker,
  runSemanticAnalysis,
  resolveAvailableCheckers,
  DEFAULT_CHECKERS,
} from "../src/semantic";

describe("type checker integration", () => {
  describe("resolveAvailableCheckers", () => {
    it("returns only checkers with available binaries", () => {
      const available = resolveAvailableCheckers();
      // npx-based checkers should always be available
      const npxCheckers = available.filter(
        (c) => c.command === "npx",
      );
      expect(npxCheckers.length).toBeGreaterThanOrEqual(1);
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

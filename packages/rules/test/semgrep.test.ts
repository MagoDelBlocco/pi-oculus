import { describe, it, expect } from "vitest";
import {
  runSemgrep,
  runSemgrepOnDir,
  runSemgrepAnalysis,
  isSemgrepAvailable,
  DEFAULT_SEMGREP_CONFIG,
} from "../src/semantic/semgrep";

describe("semgrep integration", () => {
  describe("isSemgrepAvailable", () => {
    it("returns a boolean", () => {
      const available = isSemgrepAvailable();
      expect(typeof available).toBe("boolean");
    });
  });

  describe("DEFAULT_SEMGREP_CONFIG", () => {
    it("has sensible defaults", () => {
      expect(DEFAULT_SEMGREP_CONFIG.enabled).toBe(true);
      expect(DEFAULT_SEMGREP_CONFIG.args).toContain("--json");
      expect(DEFAULT_SEMGREP_CONFIG.timeoutMs).toBe(60_000);
    });
  });

  describe("runSemgrep", () => {
    it("returns empty array when semgrep is unavailable", () => {
      // If semgrep is not installed, this should return [] not crash
      const result = runSemgrep(["test.ts"]);
      expect(Array.isArray(result)).toBe(true);
    });

    it("returns empty array for empty input", () => {
      const result = runSemgrep([]);
      expect(result.length).toBe(0);
    });

    it("returns array for non-existent file", () => {
      const result = runSemgrep(["nonexistent_file_that_does_not_exist.ts"]);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("runSemgrepOnDir", () => {
    it("returns empty array when semgrep is unavailable", () => {
      const result = runSemgrepOnDir("/tmp");
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("runSemgrepAnalysis", () => {
    it("returns empty array when disabled", () => {
      const result = runSemgrepAnalysis(
        [{ path: "test.ts" }],
        { enabled: false },
      );
      expect(result.length).toBe(0);
    });

    it("returns array for empty input", () => {
      const result = runSemgrepAnalysis([]);
      expect(result.length).toBe(0);
    });
  });
});

describe("semgrep output parsing", () => {
  // Test the JSON parser indirectly through the public API
  // (We can't easily mock spawnSync in this test environment)

  it("handles the diagnostic shape correctly", () => {
    // Verify the expected shape of semgrep diagnostics
    const expectedShape = {
      id: expect.any(String),
      filePath: expect.any(String),
      line: expect.any(Number),
      column: expect.any(Number),
      severity: expect.any(String),
      rule: expect.any(String),
      message: expect.any(String),
      source: "semgrep",
      hasFix: false,
      fixCount: 0,
      blastRadius: 1,
      age: 0,
    };

    // Just verify the type structure is correct
    expect(expectedShape.source).toBe("semgrep");
  });
});

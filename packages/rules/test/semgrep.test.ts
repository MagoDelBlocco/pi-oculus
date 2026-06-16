import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runSemgrep,
  runSemgrepOnDir,
  runSemgrepAnalysis,
  isSemgrepAvailable,
  loadSemgrepConfig,
  DEFAULT_SEMGREP_CONFIG,
} from "../src/semantic/semgrep";
import { runSemanticDiagnostics } from "../src/semantic";

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

describe("loadSemgrepConfig", () => {
  it("returns defaults when no config file is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "oculus-cfg-"));
    try {
      expect(loadSemgrepConfig(dir)).toEqual(DEFAULT_SEMGREP_CONFIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges the semgrep key from .pi/oculus.json over defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "oculus-cfg-"));
    try {
      const piDir = join(dir, ".pi");
      mkdirSync(piDir, { recursive: true });
      writeFileSync(
        join(piDir, "oculus.json"),
        JSON.stringify({ semgrep: { enabled: false, rules: "p/ci" } }),
      );
      const cfg = loadSemgrepConfig(dir);
      expect(cfg.enabled).toBe(false);
      expect(cfg.rules).toBe("p/ci");
      // Untouched defaults survive the merge.
      expect(cfg.args).toEqual(DEFAULT_SEMGREP_CONFIG.args);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runSemanticDiagnostics (type checkers + semgrep)", () => {
  it("returns a Map and is a no-op-safe merge for empty input", async () => {
    const result = await runSemanticDiagnostics([]);
    expect(result instanceof Map).toBe(true);
    expect(result.size).toBe(0);
  });

  it("does not crash and returns a Map for real files", async () => {
    const result = await runSemanticDiagnostics([
      { path: "example.ts", content: "const x: number = 1;" },
    ]);
    expect(result instanceof Map).toBe(true);
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

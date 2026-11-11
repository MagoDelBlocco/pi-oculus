import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectSourceFiles, formatCwdReport } from "../packages/core/src/analyze-cwd";

describe("workspace scan", () => {
  it("excludes generated Lean directories before applying the file limit", () => {
    const root = mkdtempSync(join(process.cwd(), ".oculus-scan-"));
    try {
      mkdirSync(join(root, ".build", "snapshots"), { recursive: true });
      mkdirSync(join(root, ".lake", "build"), { recursive: true });
      writeFileSync(join(root, ".build", "snapshots", "Old.lean"), "#check Nat\n");
      writeFileSync(join(root, ".lake", "build", "Cached.lean"), "#check Nat\n");
      writeFileSync(join(root, "Current.lean"), "#check Nat\n");
      expect(collectSourceFiles(root, 1)).toEqual([join(root, "Current.lean")]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("states when the source-file limit leaves files unchecked", () => {
    const report = formatCwdReport({ files: [], totalFiles: 500, totalRules: 0,
      totalLints: 0, durationMs: 1, truncated: true });
    expect(report).toContain("Scan limit reached; additional source files were not checked.");
  });
});

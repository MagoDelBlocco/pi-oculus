import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { leanProjectRoot, parseLeanBeamDiagnostics, runLeanBeam, runLeanBeamBatch } from "../src/semantic/lean-beam";

describe("Lean Beam diagnostics", () => {
  it("uses the active workspace for Lean files without Lake metadata", () => {
    const root = mkdtempSync(join(process.cwd(), ".oculus-lean-"));
    try {
      const nested = join(root, "heimdall-one");
      const snapshots = join(root, ".build", "snapshots");
      mkdirSync(nested, { recursive: true });
      mkdirSync(snapshots, { recursive: true });
      expect(leanProjectRoot(join(nested, "AuditTwo.lean"), root)).toBe(root);
      expect(leanProjectRoot(join(snapshots, "GMTwo_labnorm.lean"), root)).toBe(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("maps LSP positions and severities", () => {
    const [diag] = parseLeanBeamDiagnostics("Main.lean", [{
      range: { start: { line: 2, character: 4 } }, severity: 1,
      message: "unknown identifier", code: "unknownIdentifier",
    }]);
    expect(diag).toMatchObject({ line: 3, column: 5, severity: "error", rule: "lean/unknownIdentifier" });
  });

  it("requests a synced Lean LSP diagnostic snapshot", async () => {
    const root = mkdtempSync(join(process.cwd(), ".oculus-lean-"));
    try {
      writeFileSync(join(root, "lean-toolchain"), "leanprover/lean4:v4.35.0\n");
      const file = join(root, "Main.lean");
      writeFileSync(file, "#check missing\n");
      const stdout = new EventEmitter();
      const stdin = new EventEmitter() as EventEmitter & { destroyed: boolean; write: (value: string) => boolean };
      stdin.destroyed = false;
      stdin.write = (value) => {
        const request = JSON.parse(value);
        if (request.id === 1) queueMicrotask(() => stdout.emit("data", Buffer.from(JSON.stringify({
          jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" },
        }) + "\n")));
        if (request.id === 2) {
          expect(request.params.name).toBe("lean_sync");
          expect(request.params.arguments).toMatchObject({
            workspace: { root }, path: file, diagnostic_scope: "all", diagnostics_in_result: true,
          });
          queueMicrotask(() => stdout.emit("data", Buffer.from(JSON.stringify({
            jsonrpc: "2.0", id: 2, result: { structuredContent: { diagnostics: { items: [
              { range: { start: { line: 0, character: 7 } }, severity: 1, message: "unknown identifier" },
            ] } } },
          }) + "\n")));
        }
        return true;
      };
      const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => true });
      const fakeSpawn = (() => child) as unknown as typeof spawn;
      expect(leanProjectRoot(file)).toBe(root);
      const result = await runLeanBeam(file, 2000, fakeSpawn);
      expect(result.checked).toBe(true);
      expect(result.diagnostics[0]).toMatchObject({ line: 1, column: 8, message: "unknown identifier" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses one Beam process for files in the same project and reports check failures", async () => {
    const root = mkdtempSync(join(process.cwd(), ".oculus-lean-"));
    try {
      writeFileSync(join(root, "lean-toolchain"), "leanprover/lean4:v4.35.0\n");
      const files = [join(root, "A.lean"), join(root, "B.lean")];
      for (const file of files) writeFileSync(file, "#check Nat\n");
      const stdout = new EventEmitter();
      const stdin = new EventEmitter() as EventEmitter & { destroyed: boolean; write: (value: string) => boolean };
      stdin.destroyed = false;
      stdin.write = (value) => {
        const request = JSON.parse(value);
        if (request.id === 1) queueMicrotask(() => stdout.emit("data", Buffer.from(JSON.stringify({ id: 1, result: {} }) + "\n")));
        if (request.id === 2) queueMicrotask(() => stdout.emit("data", Buffer.from(JSON.stringify({ id: 2,
          result: { structuredContent: { diagnostics: { items: [] } } } }) + "\n")));
        if (request.id === 3) queueMicrotask(() => stdout.emit("data", Buffer.from(JSON.stringify({ id: 3,
          result: { isError: true, content: [{ type: "text", text: "unsupported toolchain" }] } }) + "\n")));
        return true;
      };
      const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => true });
      let launches = 0;
      const fakeSpawn = (() => { launches++; return child; }) as unknown as typeof spawn;
      const results = await runLeanBeamBatch(files, 2000, fakeSpawn);
      expect(launches).toBe(1);
      expect(results.get(files[0])?.checked).toBe(true);
      expect(results.get(files[1])?.error).toContain("unsupported toolchain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

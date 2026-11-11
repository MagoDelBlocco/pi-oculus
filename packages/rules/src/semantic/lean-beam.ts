/** Lean diagnostics through Beam's Lean LSP backed MCP surface. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import type { LintDiagnostic } from "../../../lint/src/index";

export interface LeanBeamResult {
  checked: boolean;
  diagnostics: LintDiagnostic[];
  error?: string;
}

export function leanProjectRoot(filePath: string, workspaceRoot?: string): string {
  let dir = dirname(resolve(filePath));
  let markerRoot: string | undefined;
  while (true) {
    if (["lean-toolchain", "lakefile.lean", "lakefile.toml"].some((name) => existsSync(join(dir, name)))) return dir;
    if (!markerRoot && ["AGENTS.md", ".pi"].some((name) => existsSync(join(dir, name)))) markerRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (workspaceRoot) {
    const root = resolve(workspaceRoot);
    const rel = relative(root, resolve(filePath));
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return root;
  }
  return markerRoot ?? dirname(resolve(filePath));
}

export function parseLeanBeamDiagnostics(filePath: string, items: unknown[]): LintDiagnostic[] {
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const d = item as Record<string, any>;
    const line = Number(d.range?.start?.line ?? 0) + 1;
    const column = Number(d.range?.start?.character ?? 0) + 1;
    const message = typeof d.message === "string" ? d.message : String(d.message?.value ?? "Lean diagnostic");
    const severity = d.severity === 1 || d.severity === "error" ? "error"
      : d.severity === 2 || d.severity === "warning" ? "warning"
      : d.severity === 4 || d.severity === "hint" ? "hint" : "info";
    const rule = typeof d.code === "string" ? `lean/${d.code}` : "lean/lsp";
    return [{
      id: `lean-beam:${filePath}:${line}:${column}:${rule}:${index}`,
      filePath, line, column, severity, rule, message, source: "oculus-lean",
      hasFix: false, fixCount: 0, blastRadius: 1, age: 0,
    } satisfies LintDiagnostic];
  });
}

export function leanFailureDiagnostic(filePath: string, error: string): LintDiagnostic {
  return { id: `lean-beam:${filePath}:tool-error`, filePath, line: 0, column: 0,
    severity: "warning", rule: "lean/beam-unavailable", message: error, source: "oculus-lean",
    hasFix: false, fixCount: 0, blastRadius: 1, age: 0 };
}

/** Sync saved Lean files, reusing one Beam process for every project in this batch. */
export async function runLeanBeamBatch(filePaths: readonly string[], timeoutMs = 60_000, spawnBeam: typeof spawn = spawn, workspaceRoot?: string): Promise<Map<string, LeanBeamResult>> {
  const groups = new Map<string, string[]>();
  const results = new Map<string, LeanBeamResult>();
  for (const filePath of filePaths) {
    if (!filePath.toLowerCase().endsWith(".lean")) continue;
    const root = leanProjectRoot(filePath, workspaceRoot);
    groups.set(root, [...(groups.get(root) ?? []), filePath]);
  }
  const projects = [...groups];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, projects.length) }, async () => {
    while (next < projects.length) {
      const [root, files] = projects[next++];
      try {
        const projectResults = await runProject(root, files, timeoutMs, spawnBeam);
        for (const [file, result] of projectResults) results.set(file, result);
      } catch (e) {
        for (const file of files) results.set(file, { checked: false, diagnostics: [],
          error: `Lean Beam could not start: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }));
  return results;
}

export async function runLeanBeam(filePath: string, timeoutMs = 60_000, spawnBeam: typeof spawn = spawn): Promise<LeanBeamResult> {
  const results = await runLeanBeamBatch([filePath], timeoutMs, spawnBeam);
  return results.get(filePath) ?? { checked: false, diagnostics: [] };
}

function runProject(root: string, files: string[], timeoutMs: number, spawnBeam: typeof spawn): Promise<Map<string, LeanBeamResult>> {
  return new Promise((done) => {
    const results = new Map<string, LeanBeamResult>();
    const child = spawnBeam("lean-beam-mcp", [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let index = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const file of files.slice(index)) results.set(file, { checked: false, diagnostics: [], error: reason });
      child.kill();
      done(results);
    };
    const send = (message: object) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const next = () => {
      if (index === files.length) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        done(results);
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => fail(`Lean Beam timed out after ${timeoutMs}ms${stderr ? `: ${stderr}` : ""}`), timeoutMs);
      send({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: {
        name: "lean_sync", arguments: { workspace: { root }, path: resolve(files[index]), diagnostic_scope: "all", diagnostics_in_result: true },
      } });
    };
    timer = setTimeout(() => fail(`Lean Beam initialization timed out after ${timeoutMs}ms`), timeoutMs);
    child.on("error", (e) => fail(`Lean Beam could not start: ${e.message}`));
    child.on("close", () => fail(`Lean Beam exited${stderr ? `: ${stderr}` : ""}`));
    child.stdin.on("error", (e) => fail(`Lean Beam input failed: ${e.message}`));
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-500); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (!settled && buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error || !message.result) { fail(`Lean Beam initialization failed: ${JSON.stringify(message.error ?? message)}`); break; }
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
        } else if (message.id === index + 2) {
          const result = message.result;
          const items = result?.structuredContent?.diagnostics?.items;
          if (message.error || result?.isError || !Array.isArray(items)) {
            const detail = result?.content?.find((part: any) => part.type === "text")?.text;
            results.set(files[index], { checked: false, diagnostics: [], error: `Lean Beam check failed: ${detail ?? JSON.stringify(message.error ?? result ?? "invalid response")}`.slice(0, 500) });
          } else {
            results.set(files[index], { checked: true, diagnostics: parseLeanBeamDiagnostics(files[index], items) });
          }
          index++;
          next();
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "oculus", version: "0.1.0" },
    } });
  });
}

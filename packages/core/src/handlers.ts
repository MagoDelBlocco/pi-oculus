import { readFileSync } from "node:fs";
import type {
	ContextEvent,
	ExtensionAPI,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * Snapshot lifecycle invariant:
 *
 *  - `fileSnapshots` / `fileSnapshotMetrics` are captured on `tool_call`
 *    before the edit runs, so `analyzeChangedFiles` can diff pre- vs post-edit.
 *  - They are cleared at `turn_end` after the report is built.
 *  - If `turn_end` never fires (model crash, pi reset), the next
 *    `tool_execution_end` with no pending change clears any snapshot whose
 *    file is not in `changedFiles`, preventing stale state from leaking across
 *    turns.
 */
import { analyzeFile } from "../../native/src/native-bridge";
import { analyzeChangedFiles } from "./analyze";
import { lintChangedFiles } from "./lint";
import { runAutofixSuggestions } from "./autofix";
import { buildDiagnosticReport } from "./report";
import { updateOculusStatus } from "./status";
import { makeReadFile } from "./io";
import { registerAnalyzeCommand } from "./analyze-command";
import { runBuiltInAstRules } from "../../rules/src/tree-sitter";
import { runSemanticDiagnostics } from "../../rules/src/semantic";
import { parseSuppressions, isSuppressed } from "./suppression";
import { shouldSkipByPath } from "./guard";
import type { RuleMatch } from "../../rules/src/types";
import type { LintDiagnostic } from "../../lint/src/index";
import type { EngineState } from "./state";
import type { DiagnosticRecord, Severity } from "./types";

const IN_PLACE_EDIT_RE = /\b(sed|perl|awk|ed)\b.*-i\b/;
const REPORT_PREAMBLE =
	"Automated feedback from the oculus diagnostic layer. Issues are filtered to those introduced in the files you just edited; pre-existing issues elsewhere are hidden. Resolved-this-cycle items confirm fixes you've already landed. To suppress an intentional finding, place `// oculus-disable-next-line <rule>` immediately above the line (or `// oculus-disable-file <rule>` once at the top of the file).";

export function extractDiagnostics(event: ToolResultEvent): unknown[] | null {
	const details = (event as { details?: { diagnostics?: unknown[] } }).details;
	if (!details || typeof details !== "object" || !("diagnostics" in details)) {
		return null;
	}
	const arr = (details as { diagnostics: unknown[] }).diagnostics;
	return Array.isArray(arr) ? arr : null;
}

export function registerHandlers(pi: ExtensionAPI, state: EngineState): void {
	pi.on("session_start", async (_event, ctx) => {
		state.reset();

		const { setupWidget } = await import("../../view/src/index");
		// Single source of truth: the widget reads from engine state via snapshotFn.
		// No separate tracker — what the user sees is exactly what the model sees.
		const renderWidget = setupWidget(ctx.ui, () => {
			return [...state.diagnostics.values()]
				.filter((r) => r.status !== "resolved")
				.map((r) => ({
					id: r.diagnostic.id,
					file: r.diagnostic.filePath,
					line: r.diagnostic.line,
					severity: r.diagnostic.severity,
					rule: r.diagnostic.rule,
					message: r.diagnostic.message,
					status: "open" as const,
				}));
		});

		// Re-render the widget and status bar whenever engine state changes.
		// `EngineState.subscribe` fires on both upsert and resolution, so the UI
		// stays in sync across the whole turn — not just at session start.
		const refresh = () => {
			renderWidget();
			updateOculusStatus(state, ctx.ui);
		};
		state.subscribe(refresh);
		refresh();
	});

	pi.on("tool_result", async (event, _ctx) => {
		const diagnostics = extractDiagnostics(event);
		if (!diagnostics) return;
		const now = Date.now();
		for (const diag of diagnostics) {
			const record = coerceDiagnostic(state, diag, now);
			if (record) state.upsertDiagnostic(record);
		}
	});

	pi.on("tool_call", async (event: ToolCallEvent, _ctx) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			state.pendingFileChange = true;
			const input = event.input as Record<string, unknown>;
			const filePath =
				typeof input.path === "string" ? input.path : undefined;
			if (filePath) {
				state.changedFiles.add(filePath);
				snapshotForDiff(state, filePath);
			}
			return;
		}
		if (event.toolName === "bash") {
			const input = event.input as Record<string, unknown>;
			const cmd = typeof input.command === "string" ? input.command : "";
			if (IN_PLACE_EDIT_RE.test(cmd)) state.pendingFileChange = true;
		}
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		if (!state.pendingFileChange) {
			// Defensive cleanup: if no pending file change, clear stale snapshots
			// for files not currently in changedFiles. This handles the case where
			// turn_end didn't fire (model crash, pi reset) and snapshots from a
			// previous turn would otherwise leak into the next one.
			for (const [file] of state.fileSnapshots) {
				if (!state.changedFiles.has(file)) {
					state.fileSnapshots.delete(file);
					state.fileSnapshotMetrics.delete(file);
				}
			}
			return;
		}
		state.pendingFileChange = false;

		const readFile = makeReadFile(
			ctx as { exec?: (c: string, a: string[]) => Promise<{ stdout?: string }> },
		);
		await analyzeChangedFiles(state, readFile);

		// Queue the files for end-of-turn linting. Spawning eslint+prettier+biome
		// per tool execution is too slow for tight agent loops; we batch them.
		for (const f of state.changedFiles) state.lintPending.add(f);

		state.pendingReport = buildDiagnosticReport(state);
		state.changedFiles.clear();

		if (state.pendingReport) {
			ctx?.ui?.notify?.("Oculus: diagnostic report appended to context", "info");
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (state.lintPending.size === 0 && state.changedFiles.size === 0) {
			state.fileSnapshots.clear();
			state.fileSnapshotMetrics.clear();
			state.touchedLines.clear();
			return;
		}

		const readFile = makeReadFile(
			ctx as { exec?: (c: string, a: string[]) => Promise<{ stdout?: string }> },
		);

		// Pull pending lint targets into changedFiles for the lint pass to consume.
		for (const f of state.lintPending) state.changedFiles.add(f);
		state.lintPending.clear();

		await lintChangedFiles(state, readFile);
		// AST rules: tree-sitter structural analysis at turn_end (too slow for per-edit).
		await runAstRules(state, readFile);
		// Semantic rules: type checker analysis at turn_end (slowest layer).
		await runSemanticRules(state, readFile);
		// Autofix runs only against files where lint signalled `hasFix: true` —
		// avoids spawning eslint/prettier a second time for files that nothing
		// could be done about.
		await runAutofixSuggestions(state, readFile);
		state.pendingReport = buildDiagnosticReport(state);
		state.changedFiles.clear();
		state.lintResults.clear();
		state.suggestedFixes.clear();

		// Turn boundary: drop snapshots so the NEXT turn's first edit captures
		// fresh "pre-turn" state.
		state.fileSnapshots.clear();
		state.fileSnapshotMetrics.clear();
		state.touchedLines.clear();

		if (state.pendingReport) {
			ctx?.ui?.notify?.("Oculus: lint report appended to context", "info");
		}
	});

	pi.on("context", async (event: ContextEvent, _ctx) => {
		const report = state.pendingReport;
		if (!report) return undefined;
		state.pendingReport = undefined;
		state.resolvedSinceLastReport.clear();

		// First context event of the session carries the explanatory preamble;
		// subsequent ones rely on the `<oculus-report>` wrapper alone. The model
		// learns what the tags mean once, then the wrapper is enough signal.
		const body = state.preambleSent
			? report
			: `${REPORT_PREAMBLE}\n\n${report}`;
		state.preambleSent = true;

		const wrapped = `<oculus-report>\n${body}\n</oculus-report>`;
		const userMessage = {
			role: "user",
			content: wrapped,
		} as unknown as ContextEvent["messages"][number];
		return { messages: [...event.messages, userMessage] };
	});

	// Register the /oculus-analyze command (skip in test mocks without registerCommand).
	if (typeof pi.registerCommand === "function") {
		registerAnalyzeCommand(pi);
	}
}

/**
 * Capture pre-edit content + native metrics for `filePath` if we haven't
 * already this turn. The synchronous `readFileSync` is appropriate here: the
 * `tool_call` event fires BEFORE the tool runs, so the file on disk still
 * reflects the pre-edit state we want.
 */
// ---------------------------------------------------------------------------
// AST rules — tree-sitter structural analysis at turn_end
// ---------------------------------------------------------------------------

const AST_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function shouldRunAst(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  for (const ext of AST_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

async function runAstRules(
  state: EngineState,
  readFile: (path: string) => Promise<string>,
): Promise<void> {
  // `changedFiles` holds this turn's targets (drained from `lintPending` by the
  // turn_end handler). `lintPending` is already cleared by this point, so we
  // must read from `changedFiles` here.
  const files = [...state.changedFiles].filter((p) => !shouldSkipByPath(p));
  const now = Date.now();
  const seenAstIds = new Set<string>();

  for (const filePath of files) {
    if (!shouldRunAst(filePath)) continue;
    let content: string;
    try {
      content = await readFile(filePath);
    } catch {
      continue;
    }
    if (!content) continue;

    const suppressions = parseSuppressions(content);
    const matches = runBuiltInAstRules(filePath, content);

    for (const match of matches) {
      if (isSuppressed(suppressions, match.line, match.rule)) continue;
      seenAstIds.add(match.id);
      const afterLines = content.split("\n");
      const snippet = match.line > 0 ? clipSnippet(afterLines[match.line - 1] ?? "") : undefined;
      upsertAstDiagnostic(state, match, snippet, now);
    }
  }

  // Resolve AST diagnostics that no longer appear in a re-analyzed file.
  for (const record of state.diagnostics.values()) {
    if (record.diagnostic.filePath === undefined) continue;
    if (!state.changedFiles.has(record.diagnostic.filePath)) continue;
    if (record.status === "resolved") continue;
    if (record.diagnostic.source !== "oculus-ast") continue;
    if (seenAstIds.has(record.id)) continue;
    state.markResolved(record.id);
  }
}

function upsertAstDiagnostic(
  state: EngineState,
  match: RuleMatch,
  snippet: string | undefined,
  now: number,
): void {
  const record: DiagnosticRecord = {
    id: match.id,
    diagnostic: {
      id: match.id,
      filePath: match.filePath,
      line: match.line,
      column: match.column,
      severity: match.severity,
      rule: match.rule,
      message: match.message,
      source: "oculus-ast",
      hasFix: !!match.fix,
      fixCount: match.fix ? 1 : 0,
      blastRadius: 1,
      age: 0,
      snippet,
      fix: match.fix,
    },
    status: "emitted",
    firstSeen: now,
    lastSeen: now,
  };
  state.upsertDiagnostic(record);
}

// ---------------------------------------------------------------------------
// Semantic rules — type checker analysis at turn_end
// ---------------------------------------------------------------------------

async function runSemanticRules(
  state: EngineState,
  readFile: (path: string) => Promise<string>,
): Promise<void> {
  // See runAstRules: targets live in `changedFiles` at turn_end, not lintPending.
  const files = [...state.changedFiles].filter((p) => !shouldSkipByPath(p));
  const now = Date.now();
  const seenSemanticIds = new Set<string>();

  // Collect file contents for type checking
  const checkerFiles: Array<{ path: string; content: string }> = [];
  for (const filePath of files) {
    let content: string;
    try {
      content = await readFile(filePath);
    } catch {
      continue;
    }
    if (!content) continue;
    checkerFiles.push({ path: filePath, content });
  }

  if (checkerFiles.length === 0) return;

  // Run semantic analysis: type checkers (tsc/mypy/cargo/pyright) + semgrep.
  try {
    const results = await runSemanticDiagnostics(checkerFiles);

    for (const [filePath, diagnostics] of results) {
      if (diagnostics.length === 0) continue;
      const content = checkerFiles.find((f) => f.path === filePath)?.content ?? "";
      const suppressions = parseSuppressions(content);
      const afterLines = content.split("\n");

      for (const diag of diagnostics) {
        if (isSuppressed(suppressions, diag.line, diag.rule)) continue;
        seenSemanticIds.add(diag.id);
        const snippet =
          diag.line > 0
            ? clipSnippet(afterLines[diag.line - 1] ?? "")
            : undefined;
        upsertSemanticDiagnostic(state, diag, snippet, now);
      }
    }

    // Resolve semantic diagnostics that no longer appear
    for (const record of state.diagnostics.values()) {
      if (record.status === "resolved") continue;
      if (record.diagnostic.source !== "oculus-semantic") continue;
      if (seenSemanticIds.has(record.id)) continue;
      state.markResolved(record.id);
    }
  } catch {
    // Intentional: type checkers may fail due to missing config files
    // (tsconfig.json, pyproject.toml, Cargo.toml) or no project root.
    // Semantic analysis is supplementary — the engine operates without it.
  }
}

function upsertSemanticDiagnostic(
  state: EngineState,
  diag: LintDiagnostic,
  snippet: string | undefined,
  now: number,
): void {
  const record: DiagnosticRecord = {
    id: diag.id,
    diagnostic: {
      ...diag,
      // Normalize the source so the resolution pass (which keys off
      // "oculus-semantic") can find these again. The original checker is still
      // visible to the model via the rule id (e.g. "tsc/error", "semgrep/...").
      source: "oculus-semantic",
      age: 0,
      snippet,
    },
    status: "emitted",
    firstSeen: now,
    lastSeen: now,
  };
  state.upsertDiagnostic(record);
}

function snapshotForDiff(state: EngineState, filePath: string): void {
	if (state.fileSnapshots.has(filePath)) return;
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		// New file (write tool against a non-existent path) — empty snapshot.
		content = "";
	}
	state.fileSnapshots.set(filePath, content);
	if (content) {
		state.fileSnapshotMetrics.set(filePath, analyzeFile(content));
	}
}

function coerceDiagnostic(
	state: EngineState,
	raw: unknown,
	now: number,
): DiagnosticRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const d = raw as Record<string, unknown>;
	const id =
		typeof d.id === "string"
			? d.id
			: String(d.id ?? `tool:${Math.random().toString(36).slice(2)}`);

	const existing = state.diagnostics.get(id);
	if (existing) {
		existing.lastSeen = now;
		if (existing.status === "resolved") existing.status = "emitted";
		return existing;
	}

	const severity: Severity = (() => {
		const s = d.severity;
		return s === "error" || s === "warning" || s === "info" || s === "hint"
			? s
			: "warning";
	})();

	return {
		id,
		diagnostic: {
			id,
			filePath: typeof d.filePath === "string" ? d.filePath : "",
			line: typeof d.line === "number" ? d.line : 0,
			column: typeof d.column === "number" ? d.column : 0,
			severity,
			rule: typeof d.rule === "string" ? d.rule : "",
			message: typeof d.message === "string" ? d.message : "",
			source: typeof d.source === "string" ? d.source : "",
			hasFix: typeof d.hasFix === "boolean" ? d.hasFix : false,
			fixCount: typeof d.fixCount === "number" ? d.fixCount : 0,
			blastRadius: typeof d.blastRadius === "number" ? d.blastRadius : 1,
			age: 0,
		},
		status: "emitted",
		firstSeen: now,
		lastSeen: now,
	};
}

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	createState,
	EngineState,
	extractDiagnostics,
	diagnosticsFromAnalysis,
	analyzeChangedFiles,
	lintChangedFiles,
	buildDiagnosticReport,
	activeDiagnostics,
	updateOculusStatus,
	registerHandlers,
	makeReadFile,
	parseSuppressions,
	isSuppressed,
	shouldSkipAnalysis,
	shouldSkipByPath,
	MAX_ANALYSIS_BYTES,
	runAutofixSuggestions,
} from "../packages/core/src/index";
import { changedLines, lineRange } from "../packages/core/src/diff";
import { analyzeFile } from "../packages/native/src/native-bridge";
import type {
	DiagnosticRecord,
} from "../packages/core/src/types";

vi.mock("../packages/view/src/index", () => ({
	createIssueTracker: () => ({ add: vi.fn() }),
	setupWidget: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

/* ----------------------- extractDiagnostics ----------------------- */

describe("extractDiagnostics", () => {
	it("returns the diagnostics array when present", () => {
		expect(
			extractDiagnostics({
				details: { diagnostics: [{ id: "x" }] },
			} as unknown as Parameters<typeof extractDiagnostics>[0]),
		).toEqual([{ id: "x" }]);
	});

	it("returns null without details", () => {
		expect(
			extractDiagnostics(
				{} as unknown as Parameters<typeof extractDiagnostics>[0],
			),
		).toBeNull();
	});

	it("returns null when details lacks diagnostics", () => {
		expect(
			extractDiagnostics({ details: {} } as unknown as Parameters<
				typeof extractDiagnostics
			>[0]),
		).toBeNull();
	});

	it("returns null when diagnostics is not an array", () => {
		expect(
			extractDiagnostics({
				details: { diagnostics: "nope" },
			} as unknown as Parameters<typeof extractDiagnostics>[0]),
		).toBeNull();
	});

	it("returns an empty array when diagnostics is empty", () => {
		expect(
			extractDiagnostics({
				details: { diagnostics: [] },
			} as unknown as Parameters<typeof extractDiagnostics>[0]),
		).toEqual([]);
	});
});

/* ----------------------- diff helpers ----------------------- */

describe("changedLines", () => {
	it("marks every non-empty line of a new file as new", () => {
		expect(changedLines("", "a\nb\n")).toEqual(new Set([1, 2]));
	});

	it("ignores unchanged lines", () => {
		const set = changedLines("a\nb\nc", "a\nb2\nc");
		expect(set).toEqual(new Set([2]));
	});

	it("returns empty set when content is identical", () => {
		expect(changedLines("a\nb\nc", "a\nb\nc")).toEqual(new Set());
	});

	it("does not flag moved-but-unchanged lines", () => {
		// Reordering keeps line text the same; we err on the side of not blaming.
		const set = changedLines("a\nb\nc", "c\nb\na");
		expect(set).toEqual(new Set());
	});

	it("a brand-new file with only blank lines yields an empty set", () => {
		expect(changedLines("", "\n\n\n")).toEqual(new Set());
	});

	it("an inserted line in the middle is flagged", () => {
		const set = changedLines("a\nc", "a\nb\nc");
		expect(set).toEqual(new Set([2]));
	});

	it("appended lines at the end are flagged", () => {
		const set = changedLines("a", "a\nb\nc");
		expect(set).toEqual(new Set([2, 3]));
	});

	it("treats every line of a single-line file as the full content", () => {
		expect(changedLines("", "a")).toEqual(new Set([1]));
	});
});

describe("lineRange", () => {
	it("returns null for empty set", () => {
		expect(lineRange(new Set())).toBeNull();
	});

	it("returns min/max bounds", () => {
		expect(lineRange(new Set([5, 2, 9, 4]))).toEqual([2, 9]);
	});

	it("returns [n, n] for a single-element set", () => {
		expect(lineRange(new Set([7]))).toEqual([7, 7]);
	});
});

/* ----------------------- entry point ----------------------- */

describe("entry point (oculus default export)", () => {
	it("calling oculus(pi) wires the handlers", async () => {
		const handlers: Record<string, unknown> = {};
		const mockTheme = {
			bg: (color: string, text: string) => `[bg:${color}]${text}[bg:off]`,
			fg: (color: string, text: string) => `[fg:${color}]${text}[fg:off]`,
		};
		const pi = {
			on: (k: string, fn: unknown) => {
				handlers[k] = fn;
			},
			ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, theme: mockTheme },
		};
		const { default: oculus } = await import(
			"../packages/core/src/index"
		);
		oculus(pi as unknown as Parameters<typeof oculus>[0]);
		// Expect every documented lifecycle event registered.
		for (const k of [
			"session_start",
			"tool_call",
			"tool_result",
			"tool_execution_end",
			"turn_end",
			"context",
		]) {
			expect(typeof handlers[k]).toBe("function");
		}
	});
});

/* ----------------------- diagnosticsFromAnalysis ----------------------- */

describe("diagnosticsFromAnalysis", () => {
	const base = {
		filePath: "a.ts",
		complexity: 1,
		cognitiveComplexity: 1,
		nestingDepth: 1,
		entropy: 1,
		timestamp: 0,
	};

	it("returns nothing for clean metrics", () => {
		expect(diagnosticsFromAnalysis(base)).toEqual([]);
	});

	it("emits a warning for deep nesting", () => {
		const result = diagnosticsFromAnalysis({ ...base, nestingDepth: 8 });
		expect(result).toHaveLength(1);
		expect(result[0].diagnostic.rule).toBe("oculus/deep-nesting");
		expect(result[0].diagnostic.severity).toBe("warning");
	});

	it("escalates very deep nesting to error", () => {
		const result = diagnosticsFromAnalysis({ ...base, nestingDepth: 12 });
		expect(result[0].diagnostic.severity).toBe("error");
	});

	it("emits info for high entropy", () => {
		const result = diagnosticsFromAnalysis({ ...base, entropy: 7 });
		expect(result[0].diagnostic.rule).toBe("oculus/high-entropy");
		expect(result[0].diagnostic.severity).toBe("info");
	});
});

/* ----------------------- analyzeChangedFiles (diff-aware) ----------------------- */

describe("analyzeChangedFiles", () => {
	it("is a no-op when no files changed", async () => {
		const state = createState();
		await analyzeChangedFiles(state, async () => "");
		expect(state.diagnostics.size).toBe(0);
	});

	it("reports everything when no snapshot exists (first-time file)", async () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		const src = "console.log('x'); debugger;";
		await analyzeChangedFiles(state, async () => src);

		const rules = [...state.diagnostics.values()].map((d) => d.diagnostic.rule);
		expect(rules).toContain("oculus/console-log");
		expect(rules).toContain("oculus/debugger-statement");
	});

	it("suppresses pre-existing rule matches via snapshot diff", async () => {
		const state = createState();
		const filePath = "a.ts";
		const before = "function f() {\n  debugger;\n  return 1;\n}";
		const after =
			"function f() {\n  debugger;\n  console.log('new');\n  return 1;\n}";
		state.fileSnapshots.set(filePath, before);
		state.fileSnapshotMetrics.set(filePath, analyzeFile(before));
		state.changedFiles.add(filePath);

		await analyzeChangedFiles(state, async () => after);

		const rules = [...state.diagnostics.values()].map((d) => d.diagnostic.rule);
		// console.log is on a new line → reported
		expect(rules).toContain("oculus/console-log");
		// debugger was already there → suppressed
		expect(rules).not.toContain("oculus/debugger-statement");
	});

	it("counts pre-existing issues hidden by diff filter", async () => {
		const state = createState();
		const filePath = "a.ts";
		const before = "function f() {\n  debugger;\n  return 1;\n}";
		const after =
			"function f() {\n  debugger;\n  console.log('new');\n  return 1;\n}";
		state.fileSnapshots.set(filePath, before);
		state.fileSnapshotMetrics.set(filePath, analyzeFile(before));
		state.changedFiles.add(filePath);

		await analyzeChangedFiles(state, async () => after);

		expect(state.preExistingIssues.get(filePath)).toBe(1);
	});

	it("records the per-file touched-line set from the diff", async () => {
		const state = createState();
		const filePath = "a.ts";
		const before = "a\nb\nc\n";
		const after = "a\nB2\nC2\n";
		state.fileSnapshots.set(filePath, before);
		state.changedFiles.add(filePath);

		await analyzeChangedFiles(state, async () => after);
		expect(state.touchedLines.get(filePath)).toEqual(new Set([2, 3]));
	});

	it("resolves previously-tracked diagnostics that disappear", async () => {
		const state = createState();
		const filePath = "a.ts";
		// Seed a diagnostic that "was" present in a prior turn.
		state.diagnostics.set("oculus/debugger-statement:a.ts:2:3", {
			id: "oculus/debugger-statement:a.ts:2:3",
			diagnostic: {
				id: "oculus/debugger-statement:a.ts:2:3",
				filePath,
				line: 2,
				column: 3,
				severity: "warning",
				rule: "oculus/debugger-statement",
				message: "Debugger statement left in code",
				source: "oculus-rules",
				hasFix: false,
				fixCount: 0,
				blastRadius: 1,
				age: 0,
			},
			status: "emitted",
			firstSeen: Date.now(),
			lastSeen: Date.now(),
		});

		const before = "function f() {\n  debugger;\n}";
		const after = "function f() {\n  return 1;\n}";
		state.fileSnapshots.set(filePath, before);
		state.changedFiles.add(filePath);

		await analyzeChangedFiles(state, async () => after);

		const rec = state.diagnostics.get("oculus/debugger-statement:a.ts:2:3");
		expect(rec?.status).toBe("resolved");
		expect(state.resolvedSinceLastReport.has(rec!.id)).toBe(true);
	});

	it("does not touch non-oculus diagnostics during resolution", async () => {
		const state = createState();
		const filePath = "a.ts";
		state.diagnostics.set("eslint:a.ts:1:1:semi", {
			id: "eslint:a.ts:1:1:semi",
			diagnostic: {
				id: "eslint:a.ts:1:1:semi",
				filePath,
				line: 1,
				column: 1,
				severity: "error",
				rule: "semi",
				message: "Missing semicolon",
				source: "eslint",
				hasFix: false,
				fixCount: 0,
				blastRadius: 1,
				age: 0,
			},
			status: "emitted",
			firstSeen: Date.now(),
			lastSeen: Date.now(),
		});
		state.fileSnapshots.set(filePath, "x = 1");
		state.changedFiles.add(filePath);

		await analyzeChangedFiles(state, async () => "x = 1;");

		// ESLint diagnostic is not oculus's to resolve.
		expect(state.diagnostics.get("eslint:a.ts:1:1:semi")?.status).toBe("emitted");
	});

	it("suppresses file-level diagnostics that already exceeded threshold pre-edit", async () => {
		const state = createState();
		const filePath = "a.ts";
		const deeplyNested = (depth: number) => {
			let s = "";
			for (let i = 0; i < depth; i++) s += "{ ";
			s += "1";
			for (let i = 0; i < depth; i++) s += " }";
			return s;
		};
		const before = deeplyNested(8); // exceeds threshold 6
		const after = deeplyNested(9); // still exceeds, but model didn't introduce the breach
		state.fileSnapshots.set(filePath, before);
		state.fileSnapshotMetrics.set(filePath, analyzeFile(before));
		state.changedFiles.add(filePath);

		await analyzeChangedFiles(state, async () => after);

		const rules = [...state.diagnostics.values()].map((d) => d.diagnostic.rule);
		expect(rules).not.toContain("oculus/deep-nesting");
	});
});

/* ----------------------- lintChangedFiles ----------------------- */

describe("lintChangedFiles", () => {
	it("is a no-op when no files changed", async () => {
		const state = createState();
		await lintChangedFiles(state, async () => "");
		expect(state.lintResults.size).toBe(0);
	});

	it("calls the runner and stores diagnostics", async () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		const lintFile = vi.fn().mockResolvedValue([
			{
				filePath: "a.ts",
				linter: "eslint",
				diagnostics: [
					{
						id: "eslint:a.ts:1:1:semi",
						filePath: "a.ts",
						line: 1,
						column: 1,
						severity: "error" as const,
						rule: "semi",
						message: "Missing semicolon",
						source: "eslint",
						hasFix: true,
						fixCount: 1,
						blastRadius: 1,
						age: 0,
					},
				],
				output: "",
				durationMs: 1,
			},
		]);
		await lintChangedFiles(state, async () => "const x = 1", {
			createRunner: () => ({ lintFile }),
		});

		expect(lintFile).toHaveBeenCalledWith("a.ts", "const x = 1");
		expect(state.lintResults.size).toBe(1);
		expect(state.diagnostics.size).toBe(1);
	});

	it("skips files that fail to read", async () => {
		const state = createState();
		state.changedFiles.add("missing.ts");
		const lintFile = vi.fn();
		await lintChangedFiles(
			state,
			async () => {
				throw new Error("ENOENT");
			},
			{ createRunner: () => ({ lintFile }) },
		);
		expect(lintFile).not.toHaveBeenCalled();
	});

	it("lints multiple files in parallel", async () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		state.changedFiles.add("b.ts");
		const order: string[] = [];
		const lintFile = vi.fn(async (file: string) => {
			order.push(file);
			return [
				{
					filePath: file,
					linter: "eslint",
					diagnostics: [],
					output: "",
					durationMs: 1,
				},
			];
		});
		await lintChangedFiles(state, async (p) => p, {
			createRunner: () => ({ lintFile }),
		});
		expect(lintFile).toHaveBeenCalledTimes(2);
		expect(order.sort()).toEqual(["a.ts", "b.ts"]);
	});
});

/* ----------------------- lintChangedFiles (diff-aware) ----------------------- */

describe("lintChangedFiles (diff-aware)", () => {
	const lintRecord = {
		id: "eslint:a.ts:3:1:semi",
		filePath: "a.ts",
		line: 3,
		column: 1,
		severity: "error" as const,
		rule: "semi",
		message: "Missing semicolon",
		source: "eslint",
		hasFix: false,
		fixCount: 0,
		blastRadius: 1,
		age: 0,
	};

	const lintResult = (
		filePath: string,
		linter: string,
		diags: Array<typeof lintRecord>,
	) => ({
		filePath,
		linter,
		diagnostics: diags,
		output: "",
		durationMs: 1,
	});

	it("suppresses lint diagnostics on lines untouched by this turn", async () => {
		const state = createState();
		const filePath = "a.ts";
		// before and after are identical at the diagnostic's line, so the lint
		// finding shouldn't be blamed on the model.
		const before = "x\ny\nbad-line\nz";
		const after = "x\ny\nbad-line\nz\nNEW LINE";
		state.fileSnapshots.set(filePath, before);
		state.changedFiles.add(filePath);

		const lintFile = vi.fn().mockResolvedValue([
			lintResult(filePath, "eslint", [{ ...lintRecord, line: 3 }]),
		]);
		await lintChangedFiles(state, async () => after, {
			createRunner: () => ({ lintFile }),
		});

		expect(state.diagnostics.size).toBe(0);
		// But the lint result itself is still recorded for the report counts.
		expect(state.lintResults.size).toBe(1);
	});

	it("keeps lint diagnostics on changed lines", async () => {
		const state = createState();
		const filePath = "a.ts";
		const before = "x\ny\nz";
		const after = "x\ny\nbad-line";
		state.fileSnapshots.set(filePath, before);
		state.changedFiles.add(filePath);

		const lintFile = vi.fn().mockResolvedValue([
			lintResult(filePath, "eslint", [{ ...lintRecord, line: 3 }]),
		]);
		await lintChangedFiles(state, async () => after, {
			createRunner: () => ({ lintFile }),
		});

		expect(state.diagnostics.size).toBe(1);
	});

	it("emits every lint diag for a brand-new file (no prior snapshot)", async () => {
		const state = createState();
		const filePath = "new.ts";
		state.changedFiles.add(filePath);

		const lintFile = vi.fn().mockResolvedValue([
			lintResult(filePath, "eslint", [
				{ ...lintRecord, line: 1 },
				{ ...lintRecord, id: "eslint:new.ts:2:1:semi", line: 2 },
			]),
		]);
		await lintChangedFiles(state, async () => "a\nb", {
			createRunner: () => ({ lintFile }),
		});
		expect(state.diagnostics.size).toBe(2);
	});

	it("keeps file-level (line=0) lint diagnostics regardless of diff", async () => {
		const state = createState();
		const filePath = "a.ts";
		const same = "x\ny\nz";
		state.fileSnapshots.set(filePath, same);
		state.changedFiles.add(filePath);
		const lintFile = vi.fn().mockResolvedValue([
			lintResult(filePath, "eslint", [{ ...lintRecord, id: "f", line: 0 }]),
		]);
		await lintChangedFiles(state, async () => same, {
			createRunner: () => ({ lintFile }),
		});
		expect(state.diagnostics.get("f")).toBeDefined();
	});

	it("resolves a previously-emitted lint diagnostic that disappeared", async () => {
		const state = createState();
		const filePath = "a.ts";
		state.diagnostics.set("eslint:a.ts:3:1:semi", {
			id: "eslint:a.ts:3:1:semi",
			diagnostic: { ...lintRecord },
			status: "emitted",
			firstSeen: Date.now(),
			lastSeen: Date.now(),
		});
		state.changedFiles.add(filePath);
		state.fileSnapshots.set(filePath, "x\ny\nbad-line");

		const lintFile = vi.fn().mockResolvedValue([
			lintResult(filePath, "eslint", []),
		]);
		await lintChangedFiles(state, async () => "x\ny\nfixed-line", {
			createRunner: () => ({ lintFile }),
		});

		expect(state.diagnostics.get("eslint:a.ts:3:1:semi")?.status).toBe(
			"resolved",
		);
	});

	it("does not resolve a lint diagnostic owned by a different file", async () => {
		const state = createState();
		state.diagnostics.set("eslint:other.ts:1:1:semi", {
			id: "eslint:other.ts:1:1:semi",
			diagnostic: { ...lintRecord, filePath: "other.ts", id: "eslint:other.ts:1:1:semi" },
			status: "emitted",
			firstSeen: Date.now(),
			lastSeen: Date.now(),
		});
		state.changedFiles.add("a.ts");
		state.fileSnapshots.set("a.ts", "x");
		const lintFile = vi.fn().mockResolvedValue([
			lintResult("a.ts", "eslint", []),
		]);
		await lintChangedFiles(state, async () => "x", {
			createRunner: () => ({ lintFile }),
		});
		// Diagnostic for `other.ts` must stay emitted — different file's lint pass
		// must not touch it.
		expect(state.diagnostics.get("eslint:other.ts:1:1:semi")?.status).toBe(
			"emitted",
		);
	});

	it("does not resolve non-lint diagnostics during a lint pass", async () => {
		const state = createState();
		state.diagnostics.set("oculus/eval-detected:a.ts:1:1", {
			id: "oculus/eval-detected:a.ts:1:1",
			diagnostic: {
				...lintRecord,
				id: "oculus/eval-detected:a.ts:1:1",
				rule: "oculus/eval-detected",
				source: "oculus-rules",
			},
			status: "emitted",
			firstSeen: Date.now(),
			lastSeen: Date.now(),
		});
		state.changedFiles.add("a.ts");
		state.fileSnapshots.set("a.ts", "x");
		const lintFile = vi.fn().mockResolvedValue([
			lintResult("a.ts", "eslint", []),
		]);
		await lintChangedFiles(state, async () => "x", {
			createRunner: () => ({ lintFile }),
		});
		expect(
			state.diagnostics.get("oculus/eval-detected:a.ts:1:1")?.status,
		).toBe("emitted");
	});
});

/* ----------------------- runAutofixSuggestions ----------------------- */

describe("runAutofixSuggestions", () => {
	function makeFixableRecord(filePath: string, id: string) {
		const now = Date.now();
		return {
			id,
			diagnostic: {
				id,
				filePath,
				line: 1,
				column: 1,
				severity: "warning" as const,
				rule: "semi",
				message: "Missing semicolon",
				source: "eslint",
				hasFix: true,
				fixCount: 1,
				blastRadius: 1,
				age: 0,
			},
			status: "emitted" as const,
			firstSeen: now,
			lastSeen: now,
		};
	}

	it("no-op when nothing has hasFix:true", async () => {
		const state = createState();
		const rec = makeFixableRecord("a.ts", "id");
		rec.diagnostic.hasFix = false;
		state.upsertDiagnostic(rec);
		const apply = vi.fn();
		await runAutofixSuggestions(state, async () => "x", {
			createPipeline: () => ({ apply }),
		});
		expect(apply).not.toHaveBeenCalled();
		expect(state.suggestedFixes.size).toBe(0);
	});

	it("runs pipeline only for files with a hasFix:true active diagnostic", async () => {
		const state = createState();
		state.upsertDiagnostic(makeFixableRecord("a.ts", "fixme"));
		state.upsertDiagnostic({
			...makeFixableRecord("b.ts", "nofix"),
			diagnostic: {
				...makeFixableRecord("b.ts", "nofix").diagnostic,
				hasFix: false,
			},
		});
		const apply = vi.fn().mockResolvedValue({
			filePath: "a.ts",
			before: "x",
			content: "x;",
			applied: true,
			fixers: [
				{
					fixer: "eslint",
					applied: true,
					before: "x",
					after: "x;",
					durationMs: 1,
				},
			],
			totalChars: 1,
		});
		await runAutofixSuggestions(state, async () => "x", {
			createPipeline: () => ({ apply }),
		});
		expect(apply).toHaveBeenCalledTimes(1);
		expect(apply.mock.calls[0][0]).toBe("a.ts");
	});

	it("records a SuggestedFix when the pipeline proposes a real change", async () => {
		const state = createState();
		state.upsertDiagnostic(makeFixableRecord("a.ts", "fixme"));
		const apply = vi.fn().mockResolvedValue({
			filePath: "a.ts",
			before: "x",
			content: "const x = 1;\nconst y = 2;",
			applied: true,
			fixers: [
				{
					fixer: "prettier",
					applied: true,
					before: "x",
					after: "const x = 1;\nconst y = 2;",
					durationMs: 1,
				},
			],
			totalChars: 24,
		});
		await runAutofixSuggestions(state, async () => "x", {
			createPipeline: () => ({ apply }),
		});
		const fix = state.suggestedFixes.get("a.ts");
		expect(fix).toBeDefined();
		expect(fix!.fixers).toEqual(["prettier"]);
		expect(fix!.charsChanged).toBe(24);
		expect(fix!.preview).toContain("lines");
	});

	it("ignores pipeline results that don't actually change content", async () => {
		const state = createState();
		state.upsertDiagnostic(makeFixableRecord("a.ts", "fixme"));
		const apply = vi.fn().mockResolvedValue({
			filePath: "a.ts",
			before: "x",
			content: "x",
			applied: false,
			fixers: [],
			totalChars: 0,
		});
		await runAutofixSuggestions(state, async () => "x", {
			createPipeline: () => ({ apply }),
		});
		expect(state.suggestedFixes.size).toBe(0);
	});

	it("skips files matched by the path guard (lockfiles etc.)", async () => {
		const state = createState();
		state.upsertDiagnostic(
			makeFixableRecord("package-lock.json", "fixme"),
		);
		const apply = vi.fn();
		await runAutofixSuggestions(state, async () => "{}", {
			createPipeline: () => ({ apply }),
		});
		expect(apply).not.toHaveBeenCalled();
	});

	it("ignores resolved diagnostics when picking candidates", async () => {
		const state = createState();
		state.upsertDiagnostic(makeFixableRecord("a.ts", "fixme"));
		state.markResolved("fixme");
		const apply = vi.fn();
		await runAutofixSuggestions(state, async () => "x", {
			createPipeline: () => ({ apply }),
		});
		expect(apply).not.toHaveBeenCalled();
	});
});

/* ----------------------- buildDiagnosticReport ----------------------- */

describe("buildDiagnosticReport", () => {
	it("returns empty when nothing actionable", () => {
		expect(buildDiagnosticReport(createState())).toBe("");
	});

	it("returns empty for a no-op edit (changedFiles alone is not enough)", () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		expect(buildDiagnosticReport(state)).toBe("");
	});

	it("shows severity counts in the header tally", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("e", "error"));
		state.upsertDiagnostic(makeRecord("w", "warning"));
		const report = buildDiagnosticReport(state);
		expect(report).toMatch(/Active: 2 \(1 error, 1 warning\)\./);
	});

	it("omits severity buckets with zero count from the header", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("e", "error"));
		const r = buildDiagnosticReport(state);
		expect(r).toContain("Active: 1 (1 error)");
		expect(r).not.toContain("0 warning");
		expect(r).not.toContain("0 info");
		expect(r).not.toContain("0 hint");
	});

	it("excludes resolved diagnostics from the active list", () => {
		const state = createState();
		const rec = makeRecord("r", "error");
		rec.status = "resolved";
		state.upsertDiagnostic(rec);
		expect(buildDiagnosticReport(state)).toBe("");
	});

	it("includes a Resolved-this-cycle section", () => {
		const state = createState();
		const rec = makeRecord("r", "warning");
		state.upsertDiagnostic(rec);
		state.markResolved("r");
		const report = buildDiagnosticReport(state);
		expect(report).toContain("Resolved this cycle (1):");
		expect(report).toContain("r message");
	});

	it("groups active issues by file under a 'path (N issues)' header", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("a", "error"));
		const report = buildDiagnosticReport(state);
		expect(report).toContain("test.ts (1 issue)");
	});

	it("renders inline snippet and Fix hint when present", () => {
		const state = createState();
		const rec = makeRecord("a", "error");
		rec.diagnostic.snippet = "const x = eval('1');";
		rec.diagnostic.fix = "delete this line.";
		state.upsertDiagnostic(rec);
		const report = buildDiagnosticReport(state);
		expect(report).toContain("    const x = eval('1');");
		expect(report).toContain("    Fix: delete this line.");
	});

	it("ends with a Next: directive", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("a", "error"));
		const report = buildDiagnosticReport(state);
		expect(report).toMatch(/Next: address the active issues above/);
	});

	it("Next: directive on a clean-but-resolved cycle reads as positive", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("a", "error"));
		state.markResolved("a");
		const report = buildDiagnosticReport(state);
		expect(report).toContain("Active: 0.");
		expect(report).toContain("Next: clean run");
	});

	it("does NOT render a numeric score anywhere", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("a", "error"));
		const report = buildDiagnosticReport(state);
		expect(report).not.toMatch(/score\/100/);
		// Lines start with `- [SEVERITY] line N — ...`, never with a number.
		for (const line of report.split("\n")) {
			expect(line).not.toMatch(/^-\s+\d+(?:\.\d+)?\s*:/);
		}
	});

	it("severity badges are not padded", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("a", "warning"));
		const report = buildDiagnosticReport(state);
		expect(report).toContain("[WARN]");
		expect(report).not.toContain("[WARN  ]");
	});

	it("does NOT render the legacy Changed Files / Lint Results sections", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("a", "error"));
		state.changedFiles.add("test.ts");
		state.lintResults.set("test.ts::eslint", {
			filePath: "test.ts",
			linter: "eslint",
			diagnostics: [],
			output: "",
			durationMs: 1,
		});
		const report = buildDiagnosticReport(state);
		expect(report).not.toContain("### Changed Files");
		expect(report).not.toContain("### Lint Results");
	});

	it("scoring uses touched-line proximity to order issues within a file", () => {
		const state = createState();
		const filePath = "test.ts";
		const recFar = makeRecord("far", "warning");
		recFar.diagnostic.line = 500;
		recFar.diagnostic.filePath = filePath;
		const recNear = makeRecord("near", "warning");
		recNear.diagnostic.line = 11;
		recNear.diagnostic.filePath = filePath;
		state.upsertDiagnostic(recFar);
		state.upsertDiagnostic(recNear);
		state.touchedLines.set(filePath, new Set([10, 11, 12]));

		const report = buildDiagnosticReport(state);
		const nearIdx = report.indexOf("near message");
		const farIdx = report.indexOf("far message");
		expect(nearIdx).toBeGreaterThanOrEqual(0);
		expect(farIdx).toBeGreaterThanOrEqual(0);
		expect(nearIdx).toBeLessThan(farIdx);
	});

	it("orders files by the priority of their top issue", () => {
		const state = createState();
		const errorInB = makeRecord("hi", "error");
		errorInB.diagnostic.filePath = "b.ts";
		const warningInA = makeRecord("lo", "warning");
		warningInA.diagnostic.filePath = "a.ts";
		state.upsertDiagnostic(warningInA);
		state.upsertDiagnostic(errorInB);

		const report = buildDiagnosticReport(state);
		// b.ts (containing the error) should appear before a.ts.
		expect(report.indexOf("b.ts (")).toBeLessThan(report.indexOf("a.ts ("));
	});

	it("caps per-file issue list at 20 and adds an overflow marker", () => {
		const state = createState();
		for (let i = 0; i < 25; i++) {
			const rec = makeRecord(`d${i}`,"error");
			rec.diagnostic.line = i + 1;
			state.upsertDiagnostic(rec);
		}
		const report = buildDiagnosticReport(state);
		expect(report).toContain("…and 5 more in this file");
	});

	it("renders pre-existing issues aside when present", () => {
		const state = createState();
		const rec = makeRecord("a", "error");
		rec.diagnostic.filePath = "a.ts";
		state.upsertDiagnostic(rec);
		state.preExistingIssues.set("a.ts", 3);
		const report = buildDiagnosticReport(state);
		expect(report).toContain("pre-existing issues hidden: 3 (not blocking)");
	});
})

/* ----------------------- updateOculusStatus ----------------------- */

describe("updateOculusStatus", () => {
	const mockTheme = {
		bg: (color: string, text: string) => `[bg:${color}]${text}[bg:off]`,
		fg: (color: string, text: string) => `[fg:${color}]${text}[fg:off]`,
	};

	it("reports clean when no active issues", () => {
		const ui = { setStatus: vi.fn(), theme: mockTheme };
		updateOculusStatus(createState(), ui);
		expect(ui.setStatus).toHaveBeenCalledWith(
			"oculus",
			"│ [bg:customMessageBg][fg:accent]oculus: clean[fg:off][bg:off]",
		);
	});

	it("reports major when errors exist", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("e", "error"));
		const ui = { setStatus: vi.fn(), theme: mockTheme };
		updateOculusStatus(state, ui);
		expect(ui.setStatus).toHaveBeenCalledWith(
			"oculus",
			"│ [bg:customMessageBg][fg:accent]oculus: major[fg:off][bg:off]",
		);
	});

	it("reports minor when only warnings", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("w", "warning"));
		const ui = { setStatus: vi.fn(), theme: mockTheme };
		updateOculusStatus(state, ui);
		expect(ui.setStatus).toHaveBeenCalledWith(
			"oculus",
			"│ [bg:customMessageBg][fg:accent]oculus: minor[fg:off][bg:off]",
		);
	});

	it("tolerates a missing ui", () => {
		expect(() => updateOculusStatus(createState(), null)).not.toThrow();
		expect(() => updateOculusStatus(createState(), undefined)).not.toThrow();
	});
});

/* ----------------------- EngineState ----------------------- */

describe("EngineState", () => {
	it("subscribe → listener fires on upsert", () => {
		const state = new EngineState();
		const listener = vi.fn();
		state.subscribe(listener);
		state.upsertDiagnostic(makeRecord("d", "error"));
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("subscribe → unsubscribe via returned token", () => {
		const state = new EngineState();
		const listener = vi.fn();
		const off = state.subscribe(listener);
		off();
		state.upsertDiagnostic(makeRecord("d", "error"));
		expect(listener).not.toHaveBeenCalled();
	});

	it("markResolved flips status + records in resolvedSinceLastReport", () => {
		const state = new EngineState();
		state.upsertDiagnostic(makeRecord("d", "error"));
		state.markResolved("d");
		expect(state.diagnostics.get("d")?.status).toBe("resolved");
		expect(state.resolvedSinceLastReport.has("d")).toBe(true);
	});

	it("upsertDiagnostic of a previously-resolved id clears the cycle claim", () => {
		const state = new EngineState();
		state.upsertDiagnostic(makeRecord("d", "error"));
		state.markResolved("d");
		state.upsertDiagnostic(makeRecord("d", "error"));
		expect(state.resolvedSinceLastReport.has("d")).toBe(false);
	});

	it("reset clears everything", () => {
		const state = new EngineState();
		state.upsertDiagnostic(makeRecord("d", "error"));
		state.changedFiles.add("a.ts");
		state.lintPending.add("a.ts");
		state.fileSnapshots.set("a.ts", "x");
		state.touchedLines.set("a.ts", new Set([1, 2]));
		state.pendingFileChange = true;
		state.pendingReport = "x";
		state.reset();
		expect(state.diagnostics.size).toBe(0);
		expect(state.changedFiles.size).toBe(0);
		expect(state.lintPending.size).toBe(0);
		expect(state.fileSnapshots.size).toBe(0);
		expect(state.touchedLines.size).toBe(0);
		expect(state.pendingFileChange).toBe(false);
		expect(state.pendingReport).toBeUndefined();
	});
});

/* ----------------------- registerHandlers ----------------------- */

describe("registerHandlers", () => {
	const mockTheme = {
		bg: (color: string, text: string) => `[bg:${color}]${text}[bg:off]`,
		fg: (color: string, text: string) => `[fg:${color}]${text}[fg:off]`,
	};
	function mockPi() {
		const handlers: Record<
			string,
			(e: unknown, c: unknown) => Promise<unknown>
		> = {};
		return {
			on: (name: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
				handlers[name] = fn;
			},
			ui: { setStatus: vi.fn(), notify: vi.fn(), setWidget: vi.fn(), theme: mockTheme },
			handlers,
		};
	}

	it("session_start resets state and wires subscriber via view", async () => {
		const pi = mockPi();
		const state = createState();
		state.changedFiles.add("stale.ts");
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.session_start({}, {});
		expect(state.changedFiles.size).toBe(0);
		const { setupWidget } = await import("../packages/view/src/index");
		expect(setupWidget).toHaveBeenCalled();
	});

	it("tool_result adds tool-provided diagnostics", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_result(
			{
				details: {
					diagnostics: [
						{
							id: "ext:1",
							filePath: "a.ts",
							line: 1,
							column: 1,
							severity: "error",
							rule: "ext",
							message: "boom",
							source: "ext",
							hasFix: false,
							fixCount: 0,
							blastRadius: 1,
							age: 0,
						},
					],
				},
			},
			{},
		);
		expect(state.diagnostics.get("ext:1")?.diagnostic.message).toBe("boom");
	});

	it("tool_call edit captures a pre-edit snapshot", async () => {
		const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		const dir = mkdtempSync(path.join(os.tmpdir(), "oculus-test-"));
		const file = path.join(dir, "x.ts");
		writeFileSync(file, "const x = 1;\n");

		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_call(
			{ toolName: "edit", input: { path: file } },
			{},
		);
		expect(state.fileSnapshots.get(file)).toBe("const x = 1;\n");
		expect(state.fileSnapshotMetrics.get(file)).toBeDefined();
		rmSync(dir, { recursive: true, force: true });
	});

	it("tool_call write of a non-existent path stores empty snapshot", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_call(
			{ toolName: "write", input: { path: "/tmp/does/not/exist/x.ts" } },
			{},
		);
		expect(state.fileSnapshots.get("/tmp/does/not/exist/x.ts")).toBe("");
	});

	it("tool_call recognises in-place sed/perl/awk", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		for (const cmd of [
			"sed -i 's/a/b/' f",
			"perl -i -pe 'x' f",
			"awk -i inplace '{}' f",
		]) {
			state.pendingFileChange = false;
			await pi.handlers.tool_call(
				{ toolName: "bash", input: { command: cmd } },
				{},
			);
			expect(state.pendingFileChange).toBe(true);
		}
	});

	it("tool_execution_end analyzes + queues lint but does not run linters", async () => {
		const pi = mockPi();
		const state = createState();
		state.pendingFileChange = true;
		state.changedFiles.add("a.ts");
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		const notify = vi.fn();
		await pi.handlers.tool_execution_end(
			{},
			{
				ui: { notify },
				exec: vi.fn().mockResolvedValue({ stdout: "eval('x'); debugger;" }),
			},
		);
		expect(state.pendingFileChange).toBe(false);
		expect(state.changedFiles.size).toBe(0);
		expect(state.lintPending.has("a.ts")).toBe(true);
		expect(state.lintResults.size).toBe(0); // lint deferred
		expect(notify).toHaveBeenCalledWith(
			"Oculus: diagnostic report appended to context",
			"info",
		);
	});

	it("tool_execution_end stays silent on a no-op edit", async () => {
		const pi = mockPi();
		const state = createState();
		state.pendingFileChange = true;
		state.changedFiles.add("simple.ts");
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		const notify = vi.fn();
		await pi.handlers.tool_execution_end(
			{},
			{
				ui: { notify },
				exec: vi.fn().mockResolvedValue({ stdout: "const x = 1;" }),
			},
		);
		expect(notify).not.toHaveBeenCalled();
	});

	it("tool_execution_end clears stale snapshots when no pending change", async () => {
		const pi = mockPi();
		const state = createState();
		state.fileSnapshots.set("stale.ts", "old content");
		state.fileSnapshotMetrics.set("stale.ts", {} as any);
		state.fileSnapshots.set("keep.ts", "keep content");
		state.fileSnapshotMetrics.set("keep.ts", {} as any);
		state.changedFiles.add("keep.ts");
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_execution_end({}, {});
		expect(state.fileSnapshots.has("stale.ts")).toBe(false);
		expect(state.fileSnapshotMetrics.has("stale.ts")).toBe(false);
		expect(state.fileSnapshots.has("keep.ts")).toBe(true);
	});

	it("turn_end consumes lintPending and clears snapshots", async () => {
		const pi = mockPi();
		const state = createState();
		state.lintPending.add("a.ts");
		state.fileSnapshots.set("a.ts", "before");
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.turn_end(
			{},
			{
				ui: { notify: vi.fn() },
				exec: vi.fn().mockResolvedValue({ stdout: "const x = 1" }),
			},
		);
		expect(state.lintPending.size).toBe(0);
		expect(state.fileSnapshots.size).toBe(0);
	});

	it("context wraps the report in <oculus-report> tags", async () => {
		const pi = mockPi();
		const state = createState();
		state.pendingReport = "## Oculus Diagnostic Report\nbody";
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		const result = (await pi.handlers.context(
			{ messages: [{ role: "user", content: "prev" }] },
			{},
		)) as { messages: Array<{ role: string; content: string }> };
		const injected = result.messages[result.messages.length - 1];
		expect(injected.content).toMatch(/^<oculus-report>/);
		expect(injected.content).toMatch(/<\/oculus-report>$/);
		expect(injected.content).toContain("## Oculus Diagnostic Report");
		expect(state.pendingReport).toBeUndefined();
		expect(state.resolvedSinceLastReport.size).toBe(0);
	});

	it("first context event of a session includes the preamble", async () => {
		const pi = mockPi();
		const state = createState();
		state.pendingReport = "## body";
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		const result = (await pi.handlers.context(
			{ messages: [] },
			{},
		)) as { messages: Array<{ role: string; content: string }> };
		expect(result.messages[0].content).toContain(
			"Automated feedback from the oculus diagnostic layer",
		);
		expect(state.preambleSent).toBe(true);
	});

	it("subsequent context events of the same session OMIT the preamble", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		// First injection — primes preambleSent.
		state.pendingReport = "## first";
		await pi.handlers.context({ messages: [] }, {});
		expect(state.preambleSent).toBe(true);

		// Second injection — should not re-send the preamble text.
		state.pendingReport = "## second";
		const result = (await pi.handlers.context(
			{ messages: [] },
			{},
		)) as { messages: Array<{ role: string; content: string }> };
		expect(result.messages[0].content).not.toContain(
			"Automated feedback from the oculus diagnostic layer",
		);
		// But still wrapped — the tags are the persistent signal.
		expect(result.messages[0].content).toMatch(/^<oculus-report>/);
		expect(result.messages[0].content).toContain("## second");
	});

	it("session_start resets the preamble flag", async () => {
		const pi = mockPi();
		const state = createState();
		state.preambleSent = true;
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.session_start({}, {});
		expect(state.preambleSent).toBe(false);
	});

	it("context returns undefined when no pending report", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		const result = await pi.handlers.context({ messages: [] }, {});
		expect(result).toBeUndefined();
	});
});

/* ----------------------- guard (file-size / binary / path) ----------------------- */

describe("shouldSkipAnalysis", () => {
	it("skips files larger than the max analysis size", () => {
		const big = "a".repeat(MAX_ANALYSIS_BYTES + 1);
		expect(shouldSkipAnalysis(big)).toBe(true);
	});

	it("does not skip files at or below the cap", () => {
		expect(shouldSkipAnalysis("a".repeat(MAX_ANALYSIS_BYTES))).toBe(false);
	});

	it("detects binary via a NUL byte in the first 8KB", () => {
		expect(shouldSkipAnalysis("hello world")).toBe(true);
	});

	it("doesn't trip on plain text", () => {
		expect(
			shouldSkipAnalysis("const x = 1;\nfunction y() { return 1; }"),
		).toBe(false);
	});
});

describe("shouldSkipByPath", () => {
	it("matches lockfile names", () => {
		expect(shouldSkipByPath("package-lock.json")).toBe(true);
		expect(shouldSkipByPath("a/b/yarn.lock")).toBe(true);
		expect(shouldSkipByPath("path/Cargo.lock")).toBe(true);
	});

	it("matches minified bundle extensions", () => {
		expect(shouldSkipByPath("dist/app.min.js")).toBe(true);
		expect(shouldSkipByPath("dist/app.min.css")).toBe(true);
		expect(shouldSkipByPath("dist/app.js.map")).toBe(true);
	});

	it("does not skip regular source files", () => {
		expect(shouldSkipByPath("src/a.ts")).toBe(false);
		expect(shouldSkipByPath("packages/lib/index.js")).toBe(false);
	});
});

describe("analyzeChangedFiles + guard", () => {
	it("skips files matching shouldSkipByPath without reading them", async () => {
		const state = createState();
		state.changedFiles.add("package-lock.json");
		const readFile = vi.fn();
		await analyzeChangedFiles(state, readFile);
		expect(readFile).not.toHaveBeenCalled();
		expect(state.diagnostics.size).toBe(0);
	});

	it("skips files whose content exceeds the size cap", async () => {
		const state = createState();
		state.changedFiles.add("huge.ts");
		const huge = "debugger;".repeat(MAX_ANALYSIS_BYTES);
		await analyzeChangedFiles(state, async () => huge);
		expect(state.diagnostics.size).toBe(0);
	});

	it("skips binary-looking content", async () => {
		const state = createState();
		state.changedFiles.add("a.bin");
		await analyzeChangedFiles(state, async () => "abc xyz");
		expect(state.diagnostics.size).toBe(0);
	});
});

/* ----------------------- suppression ----------------------- */

describe("parseSuppressions", () => {
	it("returns the empty map when no directives are present", () => {
		const m = parseSuppressions("const x = 1;\nconsole.log(x);");
		expect(m.lines.size).toBe(0);
		expect(m.file).toBeNull();
	});

	it("disable-line suppresses any rule on its own line", () => {
		const m = parseSuppressions("debugger; // oculus-disable-line");
		expect(isSuppressed(m, 1, "oculus/debugger-statement")).toBe(true);
		expect(isSuppressed(m, 2, "oculus/debugger-statement")).toBe(false);
	});

	it("disable-line with a rule name suppresses only that rule", () => {
		const m = parseSuppressions("eval('x'); // oculus-disable-line eval-detected");
		expect(isSuppressed(m, 1, "oculus/eval-detected")).toBe(true);
		// Different rule on same line — NOT suppressed.
		expect(isSuppressed(m, 1, "oculus/debugger-statement")).toBe(false);
	});

	it("disable-next-line targets the following line", () => {
		const m = parseSuppressions("// oculus-disable-next-line\ndebugger;");
		expect(isSuppressed(m, 2, "oculus/debugger-statement")).toBe(true);
		// Comment line itself is not suppressed.
		expect(isSuppressed(m, 1, "oculus/debugger-statement")).toBe(false);
	});

	it("disable-file applies file-wide", () => {
		const m = parseSuppressions(
			"// oculus-disable-file\nconst x = eval('1');\ndebugger;",
		);
		expect(isSuppressed(m, 99, "oculus/eval-detected")).toBe(true);
		expect(isSuppressed(m, 1, "oculus/anything")).toBe(true);
	});

	it("disable-file rule-id is rule-specific", () => {
		const m = parseSuppressions("// oculus-disable-file console-log\n");
		expect(isSuppressed(m, 100, "oculus/console-log")).toBe(true);
		expect(isSuppressed(m, 100, "oculus/debugger-statement")).toBe(false);
	});

	it("accepts the qualified `oculus/` prefix in the rule name", () => {
		const m = parseSuppressions(
			"// oculus-disable-line oculus/console-log\nconsole.log('x');",
		);
		expect(isSuppressed(m, 1, "oculus/console-log")).toBe(true);
	});

	it("accepts shell-style `#` comments", () => {
		const m = parseSuppressions("# oculus-disable-line\nfoo = bar");
		expect(isSuppressed(m, 1, "oculus/anything")).toBe(true);
	});

	it("is case-insensitive about the directive name", () => {
		const m = parseSuppressions(
			"// OCULUS-DISABLE-LINE\nconsole.log('x');",
		);
		expect(isSuppressed(m, 1, "oculus/console-log")).toBe(true);
	});

	it("stacks multiple directives across the file", () => {
		const m = parseSuppressions(
			"// oculus-disable-next-line eval-detected\n" +
				"const x = eval('1');\n" +
				"console.log('y'); // oculus-disable-line console-log",
		);
		expect(isSuppressed(m, 2, "oculus/eval-detected")).toBe(true);
		expect(isSuppressed(m, 3, "oculus/console-log")).toBe(true);
		// Line 2 not suppressed for console-log.
		expect(isSuppressed(m, 2, "oculus/console-log")).toBe(false);
	});
});

describe("analyzeChangedFiles + suppression", () => {
	it("respects oculus-disable-next-line in a fresh edit", async () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		const src =
			"// oculus-disable-next-line\nconst y = eval('1');";
		await analyzeChangedFiles(state, async () => src);
		expect(state.diagnostics.size).toBe(0);
	});

	it("respects oculus-disable-file", async () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		const src = "// oculus-disable-file\ndebugger;\nconsole.log('x');";
		await analyzeChangedFiles(state, async () => src);
		expect(state.diagnostics.size).toBe(0);
	});

	it("rule-specific suppression keeps unrelated rules visible", async () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		// Suppress only console-log; debugger should still be reported.
		const src = "// oculus-disable-file console-log\ndebugger;\nconsole.log('x');";
		await analyzeChangedFiles(state, async () => src);
		const rules = [...state.diagnostics.values()].map((d) => d.diagnostic.rule);
		expect(rules).toContain("oculus/debugger-statement");
		expect(rules).not.toContain("oculus/console-log");
	});
});

describe("lintChangedFiles + suppression", () => {
	it("suppresses lint diagnostics on a suppressed line", async () => {
		const state = createState();
		const filePath = "a.ts";
		state.changedFiles.add(filePath);
		// No pre-edit snapshot — every line is "new", so diff doesn't suppress.
		const lintFile = vi.fn().mockResolvedValue([
			{
				filePath,
				linter: "eslint",
				diagnostics: [
					{
						id: "eslint:a.ts:2:1:semi",
						filePath,
						line: 2,
						column: 1,
						severity: "error" as const,
						rule: "semi",
						message: "Missing semicolon",
						source: "eslint",
						hasFix: false,
						fixCount: 0,
						blastRadius: 1,
						age: 0,
					},
				],
				output: "",
				durationMs: 1,
			},
		]);
		await lintChangedFiles(
			state,
			async () => "// oculus-disable-next-line\nconst x = 1",
			{ createRunner: () => ({ lintFile }) },
		);
		expect(state.diagnostics.size).toBe(0);
	});
});

/* ----------------------- makeReadFile (io.ts) ----------------------- */

describe("makeReadFile", () => {
	it("falls back to fs.readFileSync when no ctx is supplied", async () => {
		const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		const dir = mkdtempSync(path.join(os.tmpdir(), "oculus-io-"));
		const file = path.join(dir, "x.ts");
		writeFileSync(file, "hello fs");

		const read = makeReadFile(undefined);
		await expect(read(file)).resolves.toBe("hello fs");
		rmSync(dir, { recursive: true, force: true });
	});

	it("prefers ctx.exec when present", async () => {
		const exec = vi.fn().mockResolvedValue({ stdout: "from-exec" });
		const read = makeReadFile({ exec });
		await expect(read("any.ts")).resolves.toBe("from-exec");
		expect(exec).toHaveBeenCalledWith("cat", ["any.ts"]);
	});

	it("falls through to fs when ctx.exec throws", async () => {
		const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		const dir = mkdtempSync(path.join(os.tmpdir(), "oculus-io-"));
		const file = path.join(dir, "y.ts");
		writeFileSync(file, "from-fs");
		const exec = vi.fn().mockRejectedValue(new Error("nope"));
		const read = makeReadFile({ exec });
		await expect(read(file)).resolves.toBe("from-fs");
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls through to fs when ctx.exec returns non-string stdout", async () => {
		const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		const dir = mkdtempSync(path.join(os.tmpdir(), "oculus-io-"));
		const file = path.join(dir, "z.ts");
		writeFileSync(file, "fs-content");
		const exec = vi.fn().mockResolvedValue({ stdout: 42 });
		const read = makeReadFile({ exec });
		await expect(read(file)).resolves.toBe("fs-content");
		rmSync(dir, { recursive: true, force: true });
	});
});

/* ----------------------- activeDiagnostics ----------------------- */

describe("activeDiagnostics", () => {
	it("filters resolved records", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("a", "error"));
		const resolved = makeRecord("b", "error");
		state.upsertDiagnostic(resolved);
		state.markResolved("b");
		const active = activeDiagnostics(state);
		expect(active.map((d) => d.id)).toEqual(["a"]);
	});

	it("returns empty array for empty state", () => {
		expect(activeDiagnostics(createState())).toEqual([]);
	});
});

/* ----------------------- EngineState (deeper) ----------------------- */

describe("EngineState (extra)", () => {
	it("multiple subscribers all fire", () => {
		const state = new EngineState();
		const a = vi.fn();
		const b = vi.fn();
		state.subscribe(a);
		state.subscribe(b);
		state.upsertDiagnostic(makeRecord("d", "error"));
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("unsubscribing one listener doesn't affect the others", () => {
		const state = new EngineState();
		const a = vi.fn();
		const b = vi.fn();
		const offA = state.subscribe(a);
		state.subscribe(b);
		offA();
		state.upsertDiagnostic(makeRecord("d", "error"));
		expect(a).not.toHaveBeenCalled();
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("markResolved on unknown id is a no-op", () => {
		const state = new EngineState();
		expect(() => state.markResolved("does-not-exist")).not.toThrow();
		expect(state.resolvedSinceLastReport.size).toBe(0);
	});

	it("markResolved on already-resolved id does not re-add to cycle set", () => {
		const state = new EngineState();
		state.upsertDiagnostic(makeRecord("d", "error"));
		state.markResolved("d");
		state.resolvedSinceLastReport.clear();
		state.markResolved("d");
		expect(state.resolvedSinceLastReport.size).toBe(0);
	});

	it("reset clears subscribers' visible state but listeners stay attached", () => {
		// Subscribers are an implementation detail; document the current behavior
		// — reset doesn't unhook listeners, so a session_restart-then-edit will
		// re-notify.
		const state = new EngineState();
		const listener = vi.fn();
		state.subscribe(listener);
		state.reset();
		state.upsertDiagnostic(makeRecord("d", "error"));
		expect(listener).toHaveBeenCalled();
	});

	it("evicts oldest resolved records when cap is exceeded", () => {
		const state = createState();
		const now = Date.now();
		for (let i = 0; i < EngineState.MAX_RECORDS; i++) {
			const id = `r${i}`;
			state.diagnostics.set(id, {
				id,
				diagnostic: makeRecord(id, "warning").diagnostic,
				status: "resolved",
				firstSeen: now - EngineState.MAX_RECORDS + i,
				lastSeen: now - EngineState.MAX_RECORDS + i,
			});
			state.resolvedSinceLastReport.add(id);
		}
		state.upsertDiagnostic(makeRecord("new", "error"));
		expect(state.diagnostics.has("r0")).toBe(false);
		expect(state.resolvedSinceLastReport.has("r0")).toBe(false);
		expect(state.diagnostics.size).toBeLessThanOrEqual(EngineState.MAX_RECORDS);
	});
});

/* ----------------------- diagnosticsFromAnalysis (extra) ----------------------- */

describe("diagnosticsFromAnalysis (extra)", () => {
	const base = {
		filePath: "a.ts",
		complexity: 1,
		cognitiveComplexity: 1,
		nestingDepth: 1,
		entropy: 1,
		timestamp: 0,
	};

	it("emits both nesting and entropy when both breach", () => {
		const result = diagnosticsFromAnalysis({
			...base,
			nestingDepth: 8,
			entropy: 7,
		});
		const rules = result.map((d) => d.diagnostic.rule).sort();
		expect(rules).toEqual([
			"oculus/deep-nesting",
			"oculus/high-entropy",
		]);
	});

	it("nesting at the threshold (=6) does not fire", () => {
		expect(diagnosticsFromAnalysis({ ...base, nestingDepth: 6 })).toEqual([]);
	});

	it("entropy at the threshold (=6.5) does not fire", () => {
		expect(diagnosticsFromAnalysis({ ...base, entropy: 6.5 })).toEqual([]);
	});

	it("formats the entropy message with 2 decimals", () => {
		const result = diagnosticsFromAnalysis({ ...base, entropy: 7.123456 });
		expect(result[0].diagnostic.message).toContain("7.12");
	});

	it("nesting=10 still warning, nesting=11 escalates to error", () => {
		expect(
			diagnosticsFromAnalysis({ ...base, nestingDepth: 10 })[0].diagnostic
				.severity,
		).toBe("warning");
		expect(
			diagnosticsFromAnalysis({ ...base, nestingDepth: 11 })[0].diagnostic
				.severity,
		).toBe("error");
	});
});

/* ----------------------- analyzeChangedFiles (extra) ----------------------- */

describe("analyzeChangedFiles (extra)", () => {
	it("when after content is empty, walks resolution against empty set", async () => {
		const state = createState();
		const filePath = "a.ts";
		// Seed a previously-emitted oculus diagnostic.
		state.diagnostics.set("oculus/debugger-statement:a.ts:1:1", {
			id: "oculus/debugger-statement:a.ts:1:1",
			diagnostic: {
				id: "oculus/debugger-statement:a.ts:1:1",
				filePath,
				line: 1,
				column: 1,
				severity: "warning",
				rule: "oculus/debugger-statement",
				message: "x",
				source: "oculus-rules",
				hasFix: false,
				fixCount: 0,
				blastRadius: 1,
				age: 0,
			},
			status: "emitted",
			firstSeen: Date.now(),
			lastSeen: Date.now(),
		});
		state.changedFiles.add(filePath);
		await analyzeChangedFiles(state, async () => "");
		expect(state.diagnostics.get("oculus/debugger-statement:a.ts:1:1")?.status)
			.toBe("resolved");
	});

	it("when readFile throws, still resolves disappeared diagnostics", async () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		state.diagnostics.set("oculus/eval-detected:a.ts:1:1", {
			id: "oculus/eval-detected:a.ts:1:1",
			diagnostic: {
				id: "oculus/eval-detected:a.ts:1:1",
				filePath: "a.ts",
				line: 1,
				column: 1,
				severity: "error",
				rule: "oculus/eval-detected",
				message: "x",
				source: "oculus-rules",
				hasFix: false,
				fixCount: 0,
				blastRadius: 1,
				age: 0,
			},
			status: "emitted",
			firstSeen: Date.now(),
			lastSeen: Date.now(),
		});
		await analyzeChangedFiles(state, async () => {
			throw new Error("nope");
		});
		expect(state.diagnostics.get("oculus/eval-detected:a.ts:1:1")?.status)
			.toBe("resolved");
	});

	it("emits file-level rule (no snapshot) when complexity newly breaches", async () => {
		const state = createState();
		const filePath = "complex.ts";
		// No prior snapshot → treated as new file; every non-empty line is "new".
		const complex = Array.from(
			{ length: 30 },
			(_, i) => `if (x${i}) { y(); }`,
		).join("\n");
		state.changedFiles.add(filePath);
		await analyzeChangedFiles(state, async () => complex);

		const rules = [...state.diagnostics.values()].map((d) => d.diagnostic.rule);
		expect(rules).toContain("oculus/high-complexity");
	});

	it("file-level rule re-fires if it didn't exist before", async () => {
		const state = createState();
		const filePath = "complex.ts";
		const cleanBefore = "export const x = 1;";
		const complex = Array.from(
			{ length: 30 },
			(_, i) => `if (x${i}) { y(); }`,
		).join("\n");
		state.fileSnapshots.set(filePath, cleanBefore);
		state.fileSnapshotMetrics.set(filePath, analyzeFile(cleanBefore));
		state.changedFiles.add(filePath);

		await analyzeChangedFiles(state, async () => complex);
		const rules = [...state.diagnostics.values()].map((d) => d.diagnostic.rule);
		expect(rules).toContain("oculus/high-complexity");
	});



	it("no touched lines are recorded for an unchanged file", async () => {
		const state = createState();
		const filePath = "same.ts";
		const same = "const x = 1;\n";
		state.fileSnapshots.set(filePath, same);
		state.changedFiles.add(filePath);
		await analyzeChangedFiles(state, async () => same);
		expect(state.touchedLines.has(filePath)).toBe(false);
	});

	it("does not regress a record when re-upserting it (stays emitted)", async () => {
		const state = createState();
		const filePath = "a.ts";
		state.changedFiles.add(filePath);
		await analyzeChangedFiles(state, async () => "debugger;");
		const before = [...state.diagnostics.values()].find(
			(d) => d.diagnostic.rule === "oculus/debugger-statement",
		);
		expect(before?.status).toBe("emitted");

		// Run again with the same content. State should remain consistent.
		state.changedFiles.add(filePath);
		await analyzeChangedFiles(state, async () => "debugger;");
		const after = [...state.diagnostics.values()].find(
			(d) => d.diagnostic.rule === "oculus/debugger-statement",
		);
		expect(after?.status).toBe("emitted");
	});
});

/* ----------------------- lintChangedFiles (extra) ----------------------- */

describe("lintChangedFiles (extra)", () => {
	it("swallows lintFile errors and skips the failed file's diagnostics", async () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		const lintFile = vi.fn().mockRejectedValue(new Error("linter crashed"));
		await lintChangedFiles(state, async () => "x", {
			createRunner: () => ({ lintFile }),
		});
		expect(state.lintResults.size).toBe(0);
		expect(state.diagnostics.size).toBe(0);
	});

	it("uses createLinterRunner when no createRunner override is supplied", async () => {
		// We can't predict what the real runners produce here without spawning
		// npx, but we CAN validate the no-op path: zero changed files = zero work.
		const state = createState();
		await lintChangedFiles(state, async () => "");
		expect(state.lintResults.size).toBe(0);
	});

	it("upserts every diagnostic produced by the runner", async () => {
		const state = createState();
		state.changedFiles.add("a.ts");
		const lintFile = vi.fn().mockResolvedValue([
			{
				filePath: "a.ts",
				linter: "eslint",
				diagnostics: [
					{
						id: "1",
						filePath: "a.ts",
						line: 1,
						column: 1,
						severity: "error" as const,
						rule: "r1",
						message: "m1",
						source: "eslint",
						hasFix: false,
						fixCount: 0,
						blastRadius: 1,
						age: 0,
					},
					{
						id: "2",
						filePath: "a.ts",
						line: 2,
						column: 1,
						severity: "warning" as const,
						rule: "r2",
						message: "m2",
						source: "eslint",
						hasFix: true,
						fixCount: 1,
						blastRadius: 1,
						age: 0,
					},
				],
				output: "",
				durationMs: 1,
			},
		]);
		await lintChangedFiles(state, async () => "x", {
			createRunner: () => ({ lintFile }),
		});
		expect(state.diagnostics.size).toBe(2);
	});
});

/* ----------------------- buildDiagnosticReport (extra) ----------------------- */

describe("buildDiagnosticReport (extra)", () => {
	it("lint-results-only (zero diagnostics, zero resolved) does NOT trigger a report", () => {
		const state = createState();
		state.lintResults.set("a.ts::eslint", {
			filePath: "a.ts",
			linter: "eslint",
			diagnostics: [],
			output: "",
			durationMs: 0,
		});
		expect(buildDiagnosticReport(state)).toBe("");
	});

	it("emits a report when only resolved-this-cycle items are present", () => {
		const state = createState();
		const rec = makeRecord("rsv", "warning");
		state.upsertDiagnostic(rec);
		state.markResolved("rsv");
		const r = buildDiagnosticReport(state);
		expect(r).toContain("Active: 0.");
		expect(r).toContain("Resolved this cycle (1):");
	});

	it("active + resolved coexist in one report", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("a", "error"));
		const rec = makeRecord("rsv", "warning");
		state.upsertDiagnostic(rec);
		state.markResolved("rsv");
		const r = buildDiagnosticReport(state);
		expect(r).toContain("Active: 1 (1 error)");
		expect(r).toContain("Resolved this cycle (1):");
	});

	it("Resolved section caps at 10 with an overflow marker", () => {
		const state = createState();
		for (let i = 0; i < 13; i++) {
			const rec = makeRecord(`r${i}`, "warning");
			state.upsertDiagnostic(rec);
			state.markResolved(`r${i}`);
		}
		const r = buildDiagnosticReport(state);
		expect(r).toContain("Resolved this cycle (13):");
		expect(r).toContain("…and 3 more");
	});

	it("renders Suggested fixes as a single-line summary", () => {
		const state = createState();
		state.suggestedFixes.set("a.ts", {
			filePath: "a.ts",
			fixers: ["eslint", "prettier"],
			charsChanged: 7,
			preview: "+2 lines (100 → 107 bytes)",
		});
		const r = buildDiagnosticReport(state);
		expect(r).toContain("Suggested fixes: a.ts (eslint+prettier).");
	});

	it("Suggested fixes one-liner concatenates multiple files", () => {
		const state = createState();
		state.suggestedFixes.set("a.ts", {
			filePath: "a.ts",
			fixers: ["eslint"],
			charsChanged: 1,
			preview: "",
		});
		state.suggestedFixes.set("b.ts", {
			filePath: "b.ts",
			fixers: ["prettier"],
			charsChanged: 1,
			preview: "",
		});
		const r = buildDiagnosticReport(state);
		expect(r).toContain(
			"Suggested fixes: a.ts (eslint), b.ts (prettier).",
		);
	});

	it("Suggested-fixes alone is enough to trigger a report", () => {
		const state = createState();
		state.suggestedFixes.set("a.ts", {
			filePath: "a.ts",
			fixers: ["prettier"],
			charsChanged: 1,
			preview: "",
		});
		const r = buildDiagnosticReport(state);
		expect(r).toContain("Suggested fixes: a.ts (prettier).");
		expect(r).toContain("Next: review the suggested fixes");
	});

	it("HINT severity surfaces in the inline badge and tally", () => {
		const state = createState();
		state.upsertDiagnostic(makeRecord("h", "hint"));
		const r = buildDiagnosticReport(state);
		expect(r).toContain("1 hint");
		expect(r).toContain("[HINT]");
	});
});

/* ----------------------- registerHandlers (extra) ----------------------- */

describe("registerHandlers (extra)", () => {
	const mockTheme = {
		bg: (color: string, text: string) => `[bg:${color}]${text}[bg:off]`,
		fg: (color: string, text: string) => `[fg:${color}]${text}[fg:off]`,
	};
	function mockPi() {
		const handlers: Record<
			string,
			(e: unknown, c: unknown) => Promise<unknown>
		> = {};
		return {
			on: (name: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
				handlers[name] = fn;
			},
			ui: { setStatus: vi.fn(), notify: vi.fn(), setWidget: vi.fn(), theme: mockTheme },
			handlers,
		};
	}

	it("tool_result with no details is a no-op", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_result({}, {});
		expect(state.diagnostics.size).toBe(0);
	});

	it("tool_result coerces missing fields to safe defaults", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_result(
			{ details: { diagnostics: [{}] } },
			{},
		);
		// The diagnostic gets an auto-generated id.
		const recs = [...state.diagnostics.values()];
		expect(recs.length).toBe(1);
		expect(recs[0].diagnostic.filePath).toBe("");
		expect(recs[0].diagnostic.severity).toBe("warning");
		expect(recs[0].diagnostic.line).toBe(0);
	});

	it("tool_result updates lastSeen for an existing record (does not duplicate)", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_result(
			{ details: { diagnostics: [{ id: "dup", message: "first" }] } },
			{},
		);
		const before = state.diagnostics.get("dup")!.lastSeen;
		await new Promise((r) => setTimeout(r, 5));
		await pi.handlers.tool_result(
			{ details: { diagnostics: [{ id: "dup", message: "second" }] } },
			{},
		);
		const after = state.diagnostics.get("dup")!.lastSeen;
		expect(state.diagnostics.size).toBe(1);
		expect(after).toBeGreaterThan(before);
		// The message is NOT overwritten — coerce returns the existing record.
		expect(state.diagnostics.get("dup")!.diagnostic.message).toBe("first");
	});

	it("tool_result revives a previously-resolved record", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_result(
			{ details: { diagnostics: [{ id: "dup" }] } },
			{},
		);
		state.markResolved("dup");
		expect(state.diagnostics.get("dup")!.status).toBe("resolved");
		await pi.handlers.tool_result(
			{ details: { diagnostics: [{ id: "dup" }] } },
			{},
		);
		expect(state.diagnostics.get("dup")!.status).toBe("emitted");
	});

	it("tool_call edit without filePath does not snapshot", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_call({ toolName: "edit", input: {} }, {});
		expect(state.fileSnapshots.size).toBe(0);
		expect(state.pendingFileChange).toBe(true);
	});

	it("tool_call bash without -i flag does not set pendingFileChange", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_call(
			{ toolName: "bash", input: { command: "ls -la" } },
			{},
		);
		expect(state.pendingFileChange).toBe(false);
	});

	it("tool_call unknown tool is ignored", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_call(
			{ toolName: "search", input: { q: "x" } },
			{},
		);
		expect(state.pendingFileChange).toBe(false);
		expect(state.fileSnapshots.size).toBe(0);
	});

	it("tool_call edit captures the snapshot exactly once per file", async () => {
		const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		const dir = mkdtempSync(path.join(os.tmpdir(), "oculus-test-"));
		const file = path.join(dir, "x.ts");
		writeFileSync(file, "first");

		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		await pi.handlers.tool_call(
			{ toolName: "edit", input: { path: file } },
			{},
		);
		// Simulate a subsequent edit to the same file — content on disk would be
		// the model's post-first-edit content, but snapshot should still hold the
		// original "first" because we don't re-capture.
		writeFileSync(file, "second");
		await pi.handlers.tool_call(
			{ toolName: "edit", input: { path: file } },
			{},
		);
		expect(state.fileSnapshots.get(file)).toBe("first");
		rmSync(dir, { recursive: true, force: true });
	});

	it("tool_execution_end is a no-op when pendingFileChange is false", async () => {
		const pi = mockPi();
		const state = createState();
		state.pendingFileChange = false;
		state.changedFiles.add("a.ts");
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		const notify = vi.fn();
		await pi.handlers.tool_execution_end(
			{},
			{ ui: { notify }, exec: vi.fn() },
		);
		// Nothing analyzed; changedFiles untouched.
		expect(state.changedFiles.has("a.ts")).toBe(true);
		expect(notify).not.toHaveBeenCalled();
	});

	it("turn_end returns early when no work is queued and clears snapshots", async () => {
		const pi = mockPi();
		const state = createState();
		state.fileSnapshots.set("a.ts", "x");
		state.touchedLines.set("a.ts", new Set([1, 2]));
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		const notify = vi.fn();
		await pi.handlers.turn_end({}, { ui: { notify } });
		expect(state.fileSnapshots.size).toBe(0);
		expect(state.touchedLines.size).toBe(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("session_start wires ctx.ui into the subscriber on each call", async () => {
		const pi = mockPi();
		const state = createState();
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		const ctx1 = { ui: { setStatus: vi.fn(), theme: mockTheme } } as any;
		const ctx2 = { ui: { setStatus: vi.fn(), theme: mockTheme } } as any;
		await pi.handlers.session_start({}, ctx1);
		await pi.handlers.session_start({}, ctx2);
		state.upsertDiagnostic(makeRecord("x", "error"));
		expect(ctx1.ui.setStatus).toHaveBeenCalled();
		expect(ctx2.ui.setStatus).toHaveBeenCalled();
	});

	it("context appends and preserves prior messages", async () => {
		const pi = mockPi();
		const state = createState();
		state.pendingReport = "## body";
		registerHandlers(
			pi as unknown as Parameters<typeof registerHandlers>[0],
			state,
		);
		const result = (await pi.handlers.context(
			{
				messages: [
					{ role: "user", content: "u1" },
					{ role: "assistant", content: "a1" },
				],
			},
			{},
		)) as { messages: Array<{ role: string; content: string }> };
		expect(result.messages.length).toBe(3);
		expect(result.messages[0].content).toBe("u1");
		expect(result.messages[1].content).toBe("a1");
		expect(result.messages[2].content).toContain("## body");
	});
});

/* ----------------------- helpers ----------------------- */

function makeRecord(
	id: string,
	severity: "error" | "warning" | "info" | "hint",
): DiagnosticRecord {
	const now = Date.now();
	return {
		id,
		diagnostic: {
			id,
			filePath: "test.ts",
			line: 1,
			column: 1,
			severity,
			rule: "test",
			message: `${id} message`,
			source: "test",
			hasFix: false,
			fixCount: 0,
			blastRadius: 1,
			age: 0,
		},
		status: "emitted",
		firstSeen: now,
		lastSeen: now,
	};
}

function scoreFromReport(report: string, id: string): number {
	// Active-issues section format:
	//   "- [SEVERITY] <score>  <path>:<line> — <message> [<rule>]"
	for (const line of report.split("\n")) {
		const match = line.match(
			/^- \[[A-Z\s]+\]\s+(\d+(?:\.\d+)?)\s+.*— (.+) \[.*\]$/,
		);
		if (match && match[2].includes(`${id} message`)) {
			return Number(match[1]);
		}
	}
	return -1;
}

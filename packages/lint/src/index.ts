/**
 * oculus-lint — Parallel external linter runner with output parsers.
 *
 * Spawns linters as child processes, feeds file content via stdin, and
 * parses output into structured diagnostics. Supports three output formats:
 *
 * - **eslint** — JSON format from `eslint --format json --stdin`
 * - **json** — Generic JSON with `diagnostics`, `messages`, or `issues` arrays
 * - **generic** — Line-based text matching `line:column severity message`
 *
 * ## Adding a new linter:
 *
 * 1. Add a `LinterConfig` to `DEFAULT_LINTERS` with command, args, and parser.
 * 2. If the output format isn't covered by the three built-in parsers, add
 *    a new parser function and register it in `parseOutput()`.
 * 3. Set `extensions` to limit which file types the linter processes.
 *
 * ## Adding a custom parser:
 *
 * 1. Add a new parser type to `LinterConfig["parser"]`.
 * 2. Write a function `parseFoo(filePath, output): LintDiagnostic[]`.
 * 3. Add a case in `parseOutput()` to dispatch to your parser.
 */

import { spawn } from "node:child_process";
import { scoreDiagnostic } from "../../native/src/native-bridge";
import { DEFAULT_LINTERS, resolveAvailableLinters } from "./linter-defaults";
import { loadLintConfig, mergeLintConfig } from "./config";

/** Severity levels matching the core diagnostic system. */
export type Severity = "error" | "warning" | "info" | "hint";

/**
 * One diagnostic from an external linter.
 *
 * Mirrors the core `Diagnostic` type but scoped to linter output.
 * Converted to `DiagnosticRecord` by the core engine.
 */
export interface LintDiagnostic {
	id: string;
	filePath: string;
	line: number;
	column: number;
	severity: Severity;
	rule: string;
	message: string;
	source: string;
	hasFix: boolean;
	fixCount: number;
	blastRadius: number;
	age: number;
}

/**
 * Result of running one linter against one file.
 *
 * Stored in `state.lintResults` keyed by `filePath::linterName` so multiple
 * linters can hold independent results for the same file.
 */
export interface LintResult {
	/** File that was linted. */
	filePath: string;
	/** Linter name (e.g. "eslint", "prettier"). */
	linter: string;
	/** Parsed diagnostics from this linter's output. */
	diagnostics: LintDiagnostic[];
	/** Raw stdout+stderr output (for debugging). */
	output: string;
	/** Wall-clock time for this linter invocation. */
	durationMs: number;
	/** Error message if the linter crashed or timed out. */
	error?: string;
}

/**
 * Configuration for one linter.
 *
 * The `command` and `args` define how the linter is invoked. `$file` in args
 * is replaced with the actual file path. File content is fed via stdin.
 *
 * The `parser` determines how stdout is parsed into diagnostics.
 * The `extensions` gate prevents JS-only linters from being fed Python files.
 */
export interface LinterConfig {
	name: string;
	command: string;
	args: readonly string[];
	parser: "eslint" | "generic" | "json";
	enabled?: boolean;
	/**
	 * File extensions (including the dot, e.g. ".ts") this linter is willing to
	 * process. When omitted the linter runs for any extension. Without this
	 * gate, JS-only linters get fed .py / .go / .rs files and either crash or
	 * mis-parse.
	 */
	extensions?: readonly string[];
}



/** True when `linter` should process `filePath` given its extension allow-list. */
export function linterApplies(
	linter: LinterConfig,
	filePath: string,
): boolean {
	if (!linter.extensions || linter.extensions.length === 0) return true;
	const lower = filePath.toLowerCase();
	return linter.extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface Spawned {
	stdout: string;
	stderr: string;
	code: number | null;
}

function runOnce(
	cmd: string,
	args: readonly string[],
	input: string,
	timeoutMs: number,
): Promise<Spawned> {
	return new Promise((resolve) => {
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const child = spawn(cmd, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "0" },
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (b) => out.push(b));
		child.stderr.on("data", (b) => err.push(b));
		child.on("error", () => {
			clearTimeout(timer);
			resolve({
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				code: null,
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				code,
			});
		});
		child.stdin.end(input);
	});
}

/**
 * Parallel linter runner.
 *
 * Spawns configured linters as child processes, feeds file content via stdin,
 * and parses output into structured diagnostics. Linters run in parallel
 * per file, and files can be processed in parallel via `lintFiles()`.
 *
 * Each linter is gated by `extensions` — a linter configured for `.ts` files
 * won't be invoked for `.py` files. Linters with `enabled: false` are skipped.
 */
export class LinterRunner {
	private readonly linters: readonly LinterConfig[];
	private readonly timeoutMs: number;

	/**
	 * Create a linter runner with custom configs or defaults.
	 *
	 * @param linters - Custom linter configs. Defaults to DEFAULT_LINTERS.
	 * @param timeoutMs - Per-linter timeout. Defaults to 30000ms.
	 */
	constructor(linters?: readonly LinterConfig[], timeoutMs?: number) {
		this.linters = linters ?? DEFAULT_LINTERS;
		this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/**
	 * Create a linter runner with auto-discovered defaults.
	 *
	 * Probes PATH for available linter binaries, loads user config from
	 * `.pi/oculus.json`, and merges the two. Linters whose binary is not
	 * found are silently dropped.
	 *
	 * @param cwd - Working directory for config file lookup
	 * @param timeoutMs - Per-linter timeout
	 */
	static async create(cwd = process.cwd(), timeoutMs?: number): Promise<LinterRunner> {
		const available = await resolveAvailableLinters();
		const userConfig = loadLintConfig(cwd);
		const merged = mergeLintConfig(available, userConfig);
		return new LinterRunner(merged, timeoutMs);
	}

	/** Run all enabled, applicable linters against one file in parallel. */
	async lintFile(filePath: string, content: string): Promise<LintResult[]> {
		const applicable = this.linters.filter(
			(l) => (l.enabled ?? true) && linterApplies(l, filePath),
		);
		return Promise.all(
			applicable.map((linter) => this.runLinter(linter, filePath, content)),
		);
	}

	/** Run all enabled linters against many files. Files run in parallel. */
	async lintFiles(
		files: Array<{ filePath: string; content: string }>,
	): Promise<Map<string, LintResult[]>> {
		const results = await Promise.all(
			files.map(async (f) => [f.filePath, await this.lintFile(f.filePath, f.content)] as const),
		);
		return new Map(results);
	}

	private async runLinter(
		linter: LinterConfig,
		filePath: string,
		content: string,
	): Promise<LintResult> {
		const start = performance.now();
		const args = linter.args.map((a) => a.replace("$file", filePath));
		try {
			const r = await runOnce(linter.command, args, content, this.timeoutMs);
			const output = r.stdout || r.stderr || "";
			const diagnostics = parseOutput(linter, filePath, output);
			return {
				filePath,
				linter: linter.name,
				diagnostics,
				output,
				durationMs: Math.round(performance.now() - start),
			};
		} catch (e) {
			return {
				filePath,
				linter: linter.name,
				diagnostics: [],
				output: "",
				durationMs: Math.round(performance.now() - start),
				error: e instanceof Error ? e.message : String(e),
			};
		}
	}
}

/** Dispatch linter output to the appropriate parser based on config. */
function parseOutput(
	linter: LinterConfig,
	filePath: string,
	output: string,
): LintDiagnostic[] {
	switch (linter.parser) {
		case "eslint":
			return parseEslintJson(filePath, output);
		case "json":
			return parseGenericJson(filePath, output, linter.name);
		case "generic":
		default:
			return parseGenericText(filePath, output, linter.name);
	}
}

/**
 * Parse eslint JSON output (`eslint --format json --stdin`).
 *
 * Eslint emits an array of file objects, each with a `messages` array.
 * Each message has ruleId, message, severity (1=warning, 2=error), line,
 * column, and optionally a `fix` object.
 *
 * eslint's "File ignored because no matching configuration was supplied"
 * is config noise, not a code issue — filtered out structurally so it
 * never reaches the model or the user.
 */
export function parseEslintJson(
	filePath: string,
	output: string,
): LintDiagnostic[] {
	try {
		const data = JSON.parse(output) as Array<{
			messages?: Array<{
				ruleId: string | null;
				message: string;
				severity: number;
				line: number;
				column: number;
				fix?: unknown;
			}>;
		}>;
		const diagnostics: LintDiagnostic[] = [];
		for (const file of data) {
			for (const msg of file.messages ?? []) {
				// Filter out eslint's config noise — not a code issue.
				// "File ignored" messages are whole-file (line 0) with no ruleId.
				if (msg.line === 0 && !msg.ruleId) continue;
				const msgLower = (msg.message ?? "").toLowerCase();
				if (msgLower.includes("file ignored")) continue;
				if (msgLower.includes("no matching configuration")) continue;
				if (msgLower.includes("no eslint configuration")) continue;
				diagnostics.push({
					id: `eslint:${filePath}:${msg.line}:${msg.column}:${msg.ruleId ?? "unknown"}`,
					filePath,
					line: msg.line,
					column: msg.column,
					severity: msg.severity === 2 ? "error" : "warning",
					rule: msg.ruleId ?? "eslint",
					message: msg.message,
					source: "eslint",
					hasFix: msg.fix != null,
					fixCount: msg.fix != null ? 1 : 0,
					blastRadius: 1,
					age: 0,
				});
			}
		}
		return diagnostics;
	} catch {
		return [];
	}
}

/**
 * Parse generic JSON output from linters that emit structured diagnostics.
 *
 * Looks for `diagnostics`, `messages`, or `issues` arrays in the JSON.
 * Each item should have `line`, `column`, `severity`, `rule`, and `message`.
 *
 * Used by biome and any linter that outputs JSON but not eslint's format.
 */
export function parseGenericJson(
	filePath: string,
	output: string,
	linterName: string,
): LintDiagnostic[] {
	try {
		const data = JSON.parse(output);
		const diagnostics: LintDiagnostic[] = [];
		const files = Array.isArray(data) ? data : [data];

		for (const file of files) {
			const list = file.diagnostics ?? file.messages ?? file.issues ?? [];
			for (const diag of list) {
				diagnostics.push({
					id: `${linterName}:${filePath}:${diag.line ?? 0}:${diag.column ?? 0}:${diag.rule ?? "unknown"}`,
					filePath,
					line: diag.line ?? 0,
					column: diag.column ?? 0,
					severity: mapSeverity(diag.severity),
					rule: diag.rule ?? linterName,
					message: diag.message ?? String(diag),
					source: linterName,
					hasFix: false,
					fixCount: 0,
					blastRadius: 1,
					age: 0,
				});
			}
		}
		return diagnostics;
	} catch {
		return [];
	}
}

/**
 * Parse plain-text linter output matching: `line:column severity message`.
 *
 * Each matching line is extracted into a diagnostic. Non-matching lines
 * (e.g. headers, footers, explanations) are silently ignored.
 *
 * Used for linters that don't support JSON output. The regex is lenient
 * to handle variations in spacing and capitalization.
 *
 * Linter config noise ("File ignored", "No files matching", etc.) is
 * filtered out structurally — these are not actionable code issues.
 */
export function parseGenericText(
	filePath: string,
	output: string,
	linterName: string,
): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Filter out config noise from any linter.
		if (line.includes("File ignored") || line.includes("No files matching")) continue;
		const match = line.match(
			/(\d+):(\d+)\s+(error|warning|info|hint)\s+(.*)/i,
		);
		if (match) {
			diagnostics.push({
				id: `${linterName}:${filePath}:${match[1]}:${match[2]}:${i}`,
				filePath,
				line: Number(match[1]),
				column: Number(match[2]),
				severity: match[3].toLowerCase() as Severity,
				rule: linterName,
				message: match[4].trim(),
				source: linterName,
				hasFix: false,
				fixCount: 0,
				blastRadius: 1,
				age: 0,
			});
		}
	}
	return diagnostics;
}

export function mapSeverity(sev: unknown): Severity {
	if (typeof sev !== "string") return "warning";
	const lower = sev.toLowerCase();
	if (lower === "error" || lower === "fatal") return "error";
	if (lower === "warning" || lower === "warn") return "warning";
	if (lower === "hint") return "hint";
	return "info";
}

export function scoreLintResult(
	result: LintResult,
): LintResult & { scoredDiagnostics: Array<LintDiagnostic & { score: number }> } {
	const scoredDiagnostics = result.diagnostics.map((d) => ({
		...d,
		score: scoreDiagnostic({
			id: d.id,
			filePath: d.filePath,
			line: d.line,
			column: d.column,
			severity: d.severity,
			rule: d.rule,
			message: d.message,
			source: d.source,
			hasFix: d.hasFix,
			fixCount: d.fixCount,
			blastRadius: d.blastRadius,
			age: d.age,
		}),
	}));
	return { ...result, scoredDiagnostics };
}

/**
 * Create a linter runner with custom configs or defaults.
 * @deprecated Use `LinterRunner.create()` for auto-discovery with binary probing.
 */
export function createLinterRunner(
	linters?: readonly LinterConfig[],
	timeoutMs?: number,
): LinterRunner {
	return new LinterRunner(linters, timeoutMs);
}

/** Re-export defaults and config for external use. */
export { DEFAULT_LINTERS } from "./linter-defaults";
export { loadLintConfig, mergeLintConfig } from "./config";
export type { OculusLintConfig } from "./config";

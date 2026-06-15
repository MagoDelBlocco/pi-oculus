import { spawn } from "node:child_process";

export type FixerName = "eslint" | "prettier" | "biome";

export interface FixerOutcome {
	fixer: FixerName;
	applied: boolean;          // true iff the fixer changed the content
	before: string;
	after: string;
	durationMs: number;
	error?: string;
}

export interface AutofixResult {
	filePath: string;
	before: string;
	content: string;          // post-pipeline content
	applied: boolean;          // any fixer applied a change
	fixers: FixerOutcome[];
	totalChars: number;        // characters changed (heuristic for "fix count")
}

export interface AutofixOptions {
	fixers?: FixerName[];
	timeoutMs?: number;
}

const DEFAULT_FIXERS: FixerName[] = ["eslint", "prettier"];
const DEFAULT_TIMEOUT_MS = 30_000;

interface Spawned {
	stdout: string;
	stderr: string;
	code: number | null;
}

async function runFixer(
	cmd: string,
	args: readonly string[],
	input: string,
	timeoutMs: number,
): Promise<Spawned> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "0" },
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`fixer ${cmd} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on("data", (b) => out.push(b));
		child.stderr.on("data", (b) => err.push(b));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
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
 * eslint --fix-dry-run emits the fixed source in the JSON `output` field
 * (per file). If `output` is absent, eslint had no fixes to apply.
 */
async function runEslint(
	filePath: string,
	content: string,
	timeoutMs: number,
): Promise<FixerOutcome> {
	const started = performance.now();
	const before = content;
	try {
		const r = await runFixer(
			"npx",
			[
				"eslint",
				"--fix-dry-run",
				"--format",
				"json",
				"--stdin",
				"--stdin-filename",
				filePath,
			],
			content,
			timeoutMs,
		);
		const after = parseEslintFixedOutput(r.stdout, content);
		return {
			fixer: "eslint",
			applied: after !== before,
			before,
			after,
			durationMs: Math.round(performance.now() - started),
		};
	} catch (e) {
		return {
			fixer: "eslint",
			applied: false,
			before,
			after: before,
			durationMs: Math.round(performance.now() - started),
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

function parseEslintFixedOutput(stdout: string, fallback: string): string {
	if (!stdout.trim()) return fallback;
	try {
		const arr = JSON.parse(stdout) as Array<{ output?: string }>;
		if (Array.isArray(arr) && arr[0] && typeof arr[0].output === "string") {
			return arr[0].output;
		}
	} catch {
		// Non-JSON output (e.g. config error) — keep original.
	}
	return fallback;
}

/**
 * prettier --stdin-filepath formats and writes the result to stdout.
 */
async function runPrettier(
	filePath: string,
	content: string,
	timeoutMs: number,
): Promise<FixerOutcome> {
	const started = performance.now();
	const before = content;
	try {
		const r = await runFixer(
			"npx",
			["prettier", "--stdin-filepath", filePath],
			content,
			timeoutMs,
		);
		const after = r.code === 0 && r.stdout ? r.stdout : before;
		return {
			fixer: "prettier",
			applied: after !== before,
			before,
			after,
			durationMs: Math.round(performance.now() - started),
		};
	} catch (e) {
		return {
			fixer: "prettier",
			applied: false,
			before,
			after: before,
			durationMs: Math.round(performance.now() - started),
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/**
 * biome format streams formatted content to stdout in stdin mode.
 */
async function runBiome(
	filePath: string,
	content: string,
	timeoutMs: number,
): Promise<FixerOutcome> {
	const started = performance.now();
	const before = content;
	try {
		const r = await runFixer(
			"npx",
			["biome", "format", "--stdin-file-path", filePath],
			content,
			timeoutMs,
		);
		const after = r.code === 0 && r.stdout ? r.stdout : before;
		return {
			fixer: "biome",
			applied: after !== before,
			before,
			after,
			durationMs: Math.round(performance.now() - started),
		};
	} catch (e) {
		return {
			fixer: "biome",
			applied: false,
			before,
			after: before,
			durationMs: Math.round(performance.now() - started),
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

const FIXER_IMPLS: Record<
	FixerName,
	(filePath: string, content: string, timeoutMs: number) => Promise<FixerOutcome>
> = {
	eslint: runEslint,
	prettier: runPrettier,
	biome: runBiome,
};

export class AutofixPipeline {
	private readonly fixers: readonly FixerName[];
	private readonly timeoutMs: number;

	constructor(opts?: AutofixOptions) {
		this.fixers = opts?.fixers ?? DEFAULT_FIXERS;
		this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async apply(filePath: string, content: string): Promise<AutofixResult> {
		const before = content;
		let current = content;
		const outcomes: FixerOutcome[] = [];
		for (const name of this.fixers) {
			const impl = FIXER_IMPLS[name];
			const outcome = await impl(filePath, current, this.timeoutMs);
			outcomes.push(outcome);
			if (outcome.applied) current = outcome.after;
		}
		return {
			filePath,
			before,
			content: current,
			applied: current !== before,
			fixers: outcomes,
			totalChars: diffCharCount(before, current),
		};
	}
}

function diffCharCount(a: string, b: string): number {
	if (a === b) return 0;
	// Cheap heuristic: count of characters changed = |len diff| + simple LCS-ish skip.
	// Not exact, just used for ranking/telemetry.
	const minLen = Math.min(a.length, b.length);
	let common = 0;
	for (let i = 0; i < minLen; i++) {
		if (a[i] === b[i]) common++;
		else break;
	}
	for (let i = 1; i <= minLen - common; i++) {
		if (a[a.length - i] === b[b.length - i]) common++;
		else break;
	}
	return Math.max(a.length, b.length) - common;
}

export function createAutofixPipeline(opts?: AutofixOptions): AutofixPipeline {
	return new AutofixPipeline(opts);
}

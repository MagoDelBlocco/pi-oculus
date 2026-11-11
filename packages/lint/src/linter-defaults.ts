/**
 * Language-aware default linter configurations.
 *
 * Ships a table of sensible defaults for every supported language. At runtime,
 * binaries are probed directly on PATH and linters
 * whose binary is not found are silently dropped. The user can override or
 * extend this table via `.pi/oculus.json` in the project root.
 */

import type { LinterConfig } from "./index";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const JS_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"] as const;
const PRETTIER_EXTENSIONS = [
	...JS_EXTENSIONS, ".css", ".scss", ".html",
] as const;

/**
 * Default linters for every language.
 *
 * Each entry is tried at startup — if the command binary is not found on PATH,
 * the linter is silently dropped. This means the extension works out of the
 * box with whatever toolchain the user has installed, and degrades gracefully
 * when a tool is missing.
 */
export const DEFAULT_LINTERS: LinterConfig[] = [
	// ── JavaScript / TypeScript ──────────────────────────────
	{
		name: "eslint",
		command: "eslint",
		args: ["--format", "json", "--stdin", "--stdin-filename", "$file"],
		parser: "eslint",
		extensions: JS_EXTENSIONS,
	},
	{
		name: "prettier",
		command: "prettier",
		args: ["--check", "--stdin-filepath", "$file"],
		parser: "status",
		extensions: PRETTIER_EXTENSIONS,
	},
	{
		name: "biome",
		command: "biome",
		args: ["check", "--reporter=json", "--stdin-file-path", "$file"],
		parser: "json",
		extensions: JS_EXTENSIONS,
	},

	// ── Python ───────────────────────────────────────────────
	{
		name: "ruff",
		command: "ruff",
		args: ["check", "--output-format", "json", "--stdin-filename", "$file", "-"],
		parser: "json",
		extensions: [".py"],
	},
	{
		name: "black",
		command: "black",
		args: ["--check", "--diff", "--stdin-filename", "$file", "-"],
		parser: "status",
		extensions: [".py"],
	},

	// ── Rust ─────────────────────────────────────────────────
	{
		name: "clippy",
		command: "cargo",
		args: ["clippy", "--message-format", "json", "--"],
		parser: "json",
		extensions: [".rs"],
	},
	{
		name: "rustfmt",
		command: "rustfmt",
		args: ["--check", "$file"],
		parser: "status",
		extensions: [".rs"],
	},

	// ── Go ───────────────────────────────────────────────────
	{
		name: "golangci-lint",
		command: "golangci-lint",
		args: ["run", "--out-format", "json", "--stdin"],
		parser: "json",
		extensions: [".go"],
	},

	// ── C / C++ ──────────────────────────────────────────────
	{
		name: "clang-tidy",
		command: "clang-tidy",
		args: ["$file"],
		parser: "generic",
		extensions: [".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hxx"],
	},

	// ── Ruby ─────────────────────────────────────────────────
	{
		name: "rubocop",
		command: "rubocop",
		args: ["--format", "json", "--stdin", "$file"],
		parser: "json",
		extensions: [".rb"],
	},

	// ── Shell scripts ────────────────────────────────────────
	{
		name: "shellcheck",
		command: "shellcheck",
		args: ["--format", "json", "-"],
		parser: "json",
		extensions: [".sh", ".bash", ".zsh"],
	},

	// ── PHP ──────────────────────────────────────────────────
	{
		name: "phpstan",
		command: "phpstan",
		args: ["analyze", "--error-format", "json", "--no-progress", "$file"],
		parser: "json",
		extensions: [".php"],
	},
];

/**
 * Resolve the effective linters by probing which binaries are available.
 *
 * Probes each unique command in the configs without invoking a shell.
 * Linters whose command is not found are silently dropped.
 *
 * @param configs - Linter configs to filter (defaults to DEFAULT_LINTERS)
 * @returns Only configs whose binary exists on PATH
 */
export async function resolveAvailableLinters(
	configs: LinterConfig[] = DEFAULT_LINTERS,
	cwd = process.cwd(),
): Promise<LinterConfig[]> {
	const commandSet = new Set(configs.map((c) => c.command));
	const available = await probeBinaries([...commandSet], cwd);
	return configs.filter((c) => available.has(c.command));
}

/** Check which commands exist on PATH. */
async function probeBinaries(commands: string[], cwd: string): Promise<Set<string>> {
	const found = new Set<string>();
	await Promise.all(
		commands.map(async (cmd) => {
			if (await binaryExists(cmd, cwd)) {
				found.add(cmd);
			}
		}),
	);
	return found;
}

/** Check if a single binary exists on PATH. */
function binaryExists(cmd: string, cwd: string): Promise<boolean> {
	if (localBinary(cmd, cwd)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const probeCmd = process.platform === "win32" ? "where" : "which";
		const child = spawn(probeCmd, [cmd], { stdio: ["ignore", "ignore", "ignore"] });
		child.on("close", (code: number) => resolve(code === 0));
		child.on("error", () => resolve(false));
	});
}

export function localBinary(cmd: string, cwd = process.cwd()): string | undefined {
	let dir = resolve(cwd);
	while (true) {
		const candidate = join(dir, "node_modules", ".bin", cmd);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

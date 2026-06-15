/**
 * Language-aware default linter configurations.
 *
 * Ships a table of sensible defaults for every supported language. At runtime,
 * binaries are probed via spawnSync("sh", ["-c", "which <cmd>"]) and linters
 * whose binary is not found are silently dropped. The user can override or
 * extend this table via `.pi/oculus.json` in the project root.
 */

import type { LinterConfig } from "./index";

const JS_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"] as const;
const PRETTIER_EXTENSIONS = [
	...JS_EXTENSIONS, ".json", ".jsonc", ".md", ".mdx", ".css", ".scss",
	".html", ".yml", ".yaml",
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
		command: "npx",
		args: ["eslint", "--format", "json", "--no-config-lookup", "--stdin", "--stdin-filename", "$file"],
		parser: "eslint",
		extensions: JS_EXTENSIONS,
	},
	{
		name: "prettier",
		command: "npx",
		args: ["prettier", "--check", "--stdin-filepath", "$file"],
		parser: "generic",
		extensions: PRETTIER_EXTENSIONS,
	},
	{
		name: "biome",
		command: "npx",
		args: ["biome", "check", "--stdin-file-path", "$file"],
		parser: "json",
		extensions: [...JS_EXTENSIONS, ".json", ".jsonc"],
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
		parser: "generic",
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
		command: "cargo",
		args: ["fmt", "--check", "--"],
		parser: "generic",
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
		args: ["--use-color", "--export-fixes=-", "$file"],
		parser: "json",
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
 * Spawns `sh -c "which <cmd>"` for each unique command in the configs.
 * Linters whose command is not found are silently dropped.
 *
 * @param configs - Linter configs to filter (defaults to DEFAULT_LINTERS)
 * @returns Only configs whose binary exists on PATH
 */
export async function resolveAvailableLinters(
	configs: LinterConfig[] = DEFAULT_LINTERS,
): Promise<LinterConfig[]> {
	const commandSet = new Set(configs.map((c) => c.command));
	const available = await probeBinaries([...commandSet]);
	return configs.filter((c) => available.has(c.command));
}

/** Check which commands exist on PATH. */
async function probeBinaries(commands: string[]): Promise<Set<string>> {
	const found = new Set<string>();
	await Promise.all(
		commands.map(async (cmd) => {
			if (await binaryExists(cmd)) {
				found.add(cmd);
			}
		}),
	);
	return found;
}

/** Check if a single binary exists on PATH. */
function binaryExists(cmd: string): Promise<boolean> {
	return new Promise((resolve) => {
		const { spawn } = require("node:child_process");
		const probeCmd = process.platform === "win32" ? "where" : "sh";
		const probeArgs = process.platform === "win32" ? [cmd] : ["-c", `which ${cmd}`];
		const child = spawn(probeCmd, probeArgs, { stdio: ["ignore", "ignore", "ignore"] });
		child.on("close", (code: number) => resolve(code === 0));
		child.on("error", () => resolve(false));
	});
}

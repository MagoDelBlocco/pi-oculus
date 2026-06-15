/**
 * Unified file reader abstraction.
 *
 * Provides a single `ReadFile` type used by analysis, linting, and autofix
 * to read file contents. Prefers `ctx.exec("cat", [path])` so the engine
 * stays sandbox-compatible (pi's tool exec runs through the agent's
 * permission system). Falls back to a direct fs read when no ctx is
 * available — useful in tests and when ctx hasn't wired exec yet.
 */

import { readFileSync } from "node:fs";

/** Synchronous or async file reader returning UTF-8 content. */
export type ReadFile = (path: string) => Promise<string>;

/** Minimal context shape needed to dispatch exec-based reads. */
interface MaybeCtx {
	exec?: (cmd: string, args: string[]) => Promise<{ stdout?: string }>;
}

/**
 * Build a ReadFile function from an optional Pi execution context.
 *
 * When `ctx.exec` is available, reads go through `cat` which respects pi's
 * permission system and sandboxing. Falls back to `readFileSync` for tests
 * or early startup before exec is wired.
 */
export function makeReadFile(ctx: MaybeCtx | undefined): ReadFile {
	return async (path: string) => {
		if (ctx?.exec) {
			try {
				const result = await ctx.exec("cat", [path]);
				if (typeof result?.stdout === "string") return result.stdout;
			} catch {
				/* fall through to fs read */
			}
		}
		return readFileSync(path, "utf8");
	};
}

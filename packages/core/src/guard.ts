/**
 * Cheap guards to keep the engine from spending real CPU on files that
 * shouldn't be analyzed: lockfiles, minified bundles, generated SVGs,
 * binaries the model "edits" by replacement. The pattern detectors are fast,
 * but feeding them a 5MB minified bundle still produces an O(n) skip-mask
 * pass, thousands of bogus pattern hits, and a polluted report.
 */

/** Files larger than this skip native analysis + linting. */
export const MAX_ANALYSIS_BYTES = 256_000;

/** Source files Oculus can meaningfully diagnose. Data and prose are excluded. */
const CODE_EXTENSIONS = new Set([
	".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
	".py", ".pyi", ".rs", ".go", ".java", ".cpp", ".cc", ".cxx",
	".c", ".h", ".hpp", ".hxx", ".rb", ".php", ".cs", ".swift",
	".kt", ".scala", ".sh", ".bash", ".zsh", ".css", ".scss",
	".less", ".html", ".vue", ".svelte", ".lean",
]);
const CODE_BASENAMES = new Set([
	"dockerfile", "makefile", "gnumakefile", "justfile", "rakefile",
	"gemfile", "procfile", ".bashrc", ".zshrc",
]);

export function isCodePath(filePath: string): boolean {
	const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	if (CODE_BASENAMES.has(name) || name.startsWith("dockerfile.")) return true;
	const dot = name.lastIndexOf(".");
	return dot >= 0 && CODE_EXTENSIONS.has(name.slice(dot));
}

/** First-N-byte window we inspect for binary detection. */
const BINARY_SNIFF_BYTES = 8_192;

/**
 * True when `content` looks like data we shouldn't analyze:
 *  - too large (`MAX_ANALYSIS_BYTES`), or
 *  - contains a NUL byte in the first ~8KB (the universal binary tell).
 *
 * Errs on the side of false negatives: text files that happen to embed `\0`
 * literals (rare in source code) will be skipped — acceptable tradeoff.
 */
export function shouldSkipAnalysis(content: string): boolean {
	if (content.length > MAX_ANALYSIS_BYTES) return true;
	const sniffEnd = Math.min(content.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < sniffEnd; i++) {
		if (content.charCodeAt(i) === 0) return true;
	}
	return false;
}

/**
 * True for path patterns we never want to analyze, regardless of content
 * size. Used as a fast pre-filter before even reading the file.
 */
const SKIP_PATH_RE =
	/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock)$|(?:\.min\.(?:js|css)$)|(?:\.map$)/;

/**
 * True when `filePath` lies under the system scratch directory `/tmp`
 * (the path itself, or anything beneath it).
 *
 * `/tmp` holds throwaway artifacts — probe snippets, diff scratch files,
 * test fixtures the model will never maintain. Diagnosing them only pollutes
 * the report, so every layer (native analysis, pattern rules, AST rules,
 * semantic rules, linters, autofix, cwd scan) treats them as invisible.
 *
 * Only absolute `/tmp/...` paths match: project-local `tmp/` or `mytmp.ts`
 * are ordinary source and remain eligible for analysis.
 */
export function isTmpPath(filePath: string): boolean {
	return filePath === "/tmp" || filePath.startsWith("/tmp/");
}

export function shouldSkipByPath(filePath: string): boolean {
	return isTmpPath(filePath) || SKIP_PATH_RE.test(filePath) || !isCodePath(filePath);
}

/**
 * Cheap guards to keep the engine from spending real CPU on files that
 * shouldn't be analyzed: lockfiles, minified bundles, generated SVGs,
 * binaries the model "edits" by replacement. The pattern detectors are fast,
 * but feeding them a 5MB minified bundle still produces an O(n) skip-mask
 * pass, thousands of bogus pattern hits, and a polluted report.
 */

/** Files larger than this skip native analysis + linting. */
export const MAX_ANALYSIS_BYTES = 256_000;

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

export function shouldSkipByPath(filePath: string): boolean {
	return SKIP_PATH_RE.test(filePath);
}

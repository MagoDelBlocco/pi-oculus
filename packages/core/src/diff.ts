/**
 * Cheap line-level diff helpers. The engine uses these to filter diagnostics
 * to ones the model actually introduced this turn, instead of blaming it for
 * pre-existing issues in files it merely touched.
 */

/**
 * 1-indexed set of line numbers in `after` whose verbatim text didn't appear
 * anywhere in `before`. Coarse but deliberate: insertions and edits both
 * produce "new" lines; moves do not. False negatives are preferable here —
 * we'd rather under-flag than wrongly blame.
 */
export function changedLines(before: string, after: string): Set<number> {
	if (!before) {
		// New file: every non-empty line is "new".
		const out = new Set<number>();
		after.split("\n").forEach((line, i) => {
			if (line.length > 0) out.add(i + 1);
		});
		return out;
	}
	const beforeSet = new Set(before.split("\n"));
	const out = new Set<number>();
	const lines = after.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!beforeSet.has(lines[i])) out.add(i + 1);
	}
	return out;
}

/** [min, max] of a changed-line set, or null when empty. */
export function lineRange(changed: Set<number>): [number, number] | null {
	if (changed.size === 0) return null;
	let lo = Infinity;
	let hi = -Infinity;
	for (const n of changed) {
		if (n < lo) lo = n;
		if (n > hi) hi = n;
	}
	return [lo, hi];
}

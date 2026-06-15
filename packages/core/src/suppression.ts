/**
 * Comment-based suppression for oculus diagnostics.
 *
 * Supported directives (case-insensitive, JS-style `//` or shell-style `#`):
 *
 *   // oculus-disable-line             — suppress any diagnostic on this line
 *   // oculus-disable-line rule-id     — suppress only `rule-id` on this line
 *   // oculus-disable-next-line        — same, but applies to the NEXT line
 *   // oculus-disable-next-line rule-id
 *   // oculus-disable-file             — suppress everything in this file
 *   // oculus-disable-file rule-id     — suppress only `rule-id` in this file
 *
 * Multiple directives can stack on the same line (e.g. two
 * `disable-next-line` comments suppress two different rules).
 *
 * The rule id can be the short name (`debugger-statement`) or the qualified
 * id (`oculus/debugger-statement`).
 */

export interface SuppressionMap {
	/** Per-line suppressions. Value `"*"` means any rule; Set is specific rules. */
	readonly lines: ReadonlyMap<number, "*" | ReadonlySet<string>>;
	/** Whole-file suppressions. `"*"` means any rule. */
	readonly file: "*" | ReadonlySet<string> | null;
}

const EMPTY: SuppressionMap = { lines: new Map(), file: null };

const DIRECTIVE_RE =
	/(?:\/\/|#)\s*oculus-(disable-line|disable-next-line|disable-file)\b([^\n]*)/gi;

export function parseSuppressions(content: string): SuppressionMap {
	if (!content || !/oculus-disable/i.test(content)) return EMPTY;

	const lines = new Map<number, "*" | Set<string>>();
	let file: "*" | Set<string> | null = null;
	const lineNo = lineNumberLookup(content);

	for (const match of content.matchAll(DIRECTIVE_RE)) {
		const directive = match[1].toLowerCase();
		const rulePart = (match[2] ?? "").trim();
		const rules = parseRuleList(rulePart);
		const matchLine = lineNo(match.index ?? 0);

		if (directive === "disable-file") {
			file = mergeRules(file, rules);
			continue;
		}
		const target = directive === "disable-next-line" ? matchLine + 1 : matchLine;
		const existing = lines.get(target);
		lines.set(target, mergeRules(existing ?? null, rules) ?? "*");
	}

	return { lines, file };
}

export function isSuppressed(
	map: SuppressionMap,
	line: number,
	rule: string,
): boolean {
	if (map.file === "*") return true;
	if (map.file && ruleMatches(map.file, rule)) return true;
	// File-level diagnostics (line 0) are also covered by file-level suppressions.
	// Line-specific suppressions don't apply to file-level diagnostics.
	if (line === 0) return false;
	const entry = map.lines.get(line);
	if (!entry) return false;
	if (entry === "*") return true;
	return ruleMatches(entry, rule);
}

/* ----------------------- internals ----------------------- */

function parseRuleList(s: string): "*" | Set<string> {
	if (!s) return "*";
	// Accept comma- or space-separated list. Strip "oculus/" prefix for matching.
	const parts = s
		.split(/[\s,]+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	if (parts.length === 0) return "*";
	return new Set(parts.map(normalizeRule));
}

function mergeRules(
	existing: "*" | Set<string> | null,
	incoming: "*" | Set<string>,
): "*" | Set<string> {
	if (existing === "*" || incoming === "*") return "*";
	if (existing === null) return incoming;
	const merged = new Set(existing);
	for (const r of incoming) merged.add(r);
	return merged;
}

function ruleMatches(set: ReadonlySet<string>, rule: string): boolean {
	return set.has(normalizeRule(rule));
}

function normalizeRule(rule: string): string {
	const lower = rule.toLowerCase();
	const slash = lower.lastIndexOf("/");
	return slash >= 0 ? lower.slice(slash + 1) : lower;
}

/** Returns a fast offset → 1-indexed line-number lookup. */
function lineNumberLookup(content: string): (offset: number) => number {
	const newlines: number[] = [];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") newlines.push(i);
	}
	return (offset) => {
		// Binary search: first newline strictly greater than offset.
		let lo = 0;
		let hi = newlines.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (newlines[mid] < offset) lo = mid + 1;
			else hi = mid;
		}
		return lo + 1;
	};
}

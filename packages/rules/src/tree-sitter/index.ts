// oculus-disable-file oculus/high-cognitive-complexity
// oculus-disable-file oculus/high-complexity
/**
 * oculus-rules/tree-sitter — structural pattern matching via tree-sitter queries.
 *
 * Uses the native tree-sitter bindings (not WASM) for speed. Falls back to
 * no-op when the bindings fail to load, allowing oculus to operate without
 * AST analysis in environments where tree-sitter is unavailable.
 *
 * NOTE: Defensive try-catch wrappers add cognitive complexity — the logic
 * itself is linear. Suppression is intentional.
 */

import type { RuleMatch } from "../types";
import {
  detectDangerousAPIs,
  detectDeepNesting,
  detectLongParams,
  detectMagicNumbers,
  detectUnusedImports,
} from "./rules";

// ---------------------------------------------------------------------------
// Parser — shared via rules.ts (same Parser class, fresh instance per parse).
// ---------------------------------------------------------------------------

import { ensureParser, parseSource, getParserClass, getTsLanguage } from "./rules";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A single AST rule definition.
 */
export interface TreeSitterRule {
  /** Unique rule identifier (e.g. "unused-import"). */
  id: string;
  /** Language identifier (e.g. "typescript"). Currently only "typescript" is supported. */
  language: string;
  /** tree-sitter query in S-expression syntax. */
  query: string;
  /** Human-readable message shown in the diagnostic report. */
  message: string;
  /** Severity level. */
  severity: "error" | "warning" | "info" | "hint";
  /** Canonical rule id (e.g. "oculus/unused-import"). */
  rule: string;
  /** Optional one-line fix hint. */
  fix?: string;
}

/**
 * Run a tree-sitter query against source code.
 *
 * @param filePath - File path for attribution
 * @param source - Source code to parse
 * @param querySexp - tree-sitter query in S-expression syntax
 * @param ruleId - Canonical rule id (e.g. "oculus/unused-import")
 * @param message - Human-readable message
 * @param severity - Severity level
 * @param fix - Optional fix hint
 * @returns Array of rule matches (empty if tree-sitter unavailable)
 */
export function runAstQuery(
  filePath: string,
  source: string,
  querySexp: string,
  ruleId: string,
  message: string,
  severity: "error" | "warning" | "info" | "hint",
  fix?: string,
): RuleMatch[] {
  if (!ensureParser()) return [];

  try {
    const tree = parseSource(source);
    if (!tree || !tree.rootNode) return [];

    const ParserClass = getParserClass();
    const lang = getTsLanguage();
    const query = new ParserClass.Query(lang.language, querySexp);
    const matches = query.matches(tree.rootNode);
    const lines = source.split("\n");
    const results: RuleMatch[] = [];

    for (const match of matches) {
      for (const capture of match.captures) {
        const { name, node } = capture;
        if (!node) continue;
        const line = node.startPosition.row + 1;
        const column = node.startPosition.column + 1;
        const snippet = lines[line - 1]?.trim();
        results.push({
          id: `${ruleId}:${filePath}:${line}:${column}`,
          ruleId,
          rule: ruleId,
          message,
          severity,
          filePath,
          line,
          column,
          snippet,
          fix,
        });
      }
    }
    return results;
  } catch {
    // Intentional: tree-sitter may crash on malformed source or invalid queries.
    // Return empty — the caller handles degradation.
    return [];
  }
}

/**
 * Run a set of TreeSitterRule definitions against source code.
 *
 * Each rule is executed independently and results are concatenated.
 * If tree-sitter is unavailable, returns an empty array.
 *
 * @param filePath - File path for attribution
 * @param content - Source code to analyze
 * @param rules - Array of rule definitions
 * @returns Combined matches from all rules
 */
export async function runTreeSitterRules(
  filePath: string,
  content: string,
  rules: TreeSitterRule[],
): Promise<RuleMatch[]> {
  if (!ensureParser()) return [];
  const all: RuleMatch[] = [];
  for (const rule of rules) {
    if (rule.language !== "typescript") continue;
    const matches = runAstQuery(
      filePath,
      content,
      rule.query,
      rule.rule,
      rule.message,
      rule.severity,
      rule.fix,
    );
    all.push(...matches);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Built-in rule suite — runs all 5 starter rules in one pass.
// ---------------------------------------------------------------------------

/**
 * Run all built-in AST rules against a TypeScript/TSX file.
 *
 * Returns an array of RuleMatch covering:
 *   - unused imports
 *   - deep nesting (> 4 levels)
 *   - dangerous APIs (eval, exec, innerHTML)
 *   - magic numbers (numeric literals > 2 digits, excluding 0 and 1)
 *   - long parameter lists (> 5 parameters)
 *
 * @param filePath - File path for attribution
 * @param source - Source code to analyze
 * @returns All rule matches from the built-in suite
 */
export function runBuiltInAstRules(
  filePath: string,
  source: string,
): RuleMatch[] {
  if (!ensureParser()) return [];

  const all: RuleMatch[] = [];
  const rules = [
    () => detectUnusedImports(filePath, source),
    () => detectDeepNesting(filePath, source),
    () => detectDangerousAPIs(filePath, source),
    () => detectMagicNumbers(filePath, source),
    () => detectLongParams(filePath, source),
  ];
  for (const fn of rules) {
    try {
      all.push(...fn());
    } catch {
      // Intentional: one failing rule must not abort the entire suite.
      // Each rule is independent — skip the offender and continue.
    }
  }
  return all;
}

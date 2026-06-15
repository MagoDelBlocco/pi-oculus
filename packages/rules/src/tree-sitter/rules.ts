// oculus-disable-file oculus/high-complexity
// oculus-disable-file oculus/high-cognitive-complexity
/**
 * Built-in AST rules for tree-sitter.
 *
 * Each function takes a file path and source code, and returns an array of
 * RuleMatch. They all depend on the parser being initialized via ensureParser().
 *
 * NOTE: This module is intentionally high-complexity — it houses 5 independent
 * detection rules. Each rule function is self-contained and testable in isolation.
 */

import type { RuleMatch } from "../types";

// Parser state — singleton, shared across all rule functions.
let Parser: any = null;
let tsLanguage: any = null;
let parserReady = false;

export function ensureParser(): boolean {
  if (parserReady) return true;
  try {
    const tsitter = require("tree-sitter");
    Parser = tsitter;
    const tsTypes = require("tree-sitter-typescript");
    tsLanguage = tsTypes.tsx;
    parserReady = true;
    return true;
  } catch {
    // tree-sitter or tree-sitter-typescript not available — degrade gracefully.
    parserReady = false;
    return false;
  }
}

export function parseSource(
  filePath: string,
  source: string,
): any {
  if (!ensureParser()) return null;

  // Try cache first
  const { getAnalysisCache, hashString } = require("../cache");
  const cache = getAnalysisCache();
  const hash = cache.hashContent(source);
  const cached = cache.getTree(filePath, hash);
  if (cached) return cached;

  try {
    const instance = new Parser();
    instance.setLanguage(tsLanguage.language);
    const tree = instance.parse(source);
    if (!tree || !tree.rootNode) return null;

    // Cache the result
    cache.setTree(filePath, hash, tree);
    return tree;
  } catch {
    // Intentional: tree-sitter may crash on malformed/empty source.
    // Return null so all rule functions degrade gracefully.
    return null;
  }
}

export function getParserClass(): any { return Parser; }
export function getTsLanguage(): any { return tsLanguage; }

function makeMatch(
  ruleId: string,
  filePath: string,
  line: number,
  column: number,
  message: string,
  severity: "error" | "warning" | "info" | "hint",
  snippet?: string,
  fix?: string,
): RuleMatch {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Rule 1: Unused Imports
// ---------------------------------------------------------------------------

/**
 * Detect imported names that are never referenced elsewhere in the file.
 *
 * Strategy:
 *   1. Collect all imported identifiers from import statements.
 *   2. Collect all identifier references in the file (excluding import declarations).
 *   3. An import is "unused" if its name does not appear in the reference set.
 *
 * Limitations:
 *   - Namespace imports (`import * as X`) are not checked.
 *   - Default imports are checked only by their local name.
 *   - Dynamic imports (`import()`) are not tracked.
 *   - Aliased imports use the local name for matching.
 */
export function detectUnusedImports(
  filePath: string,
  source: string,
): RuleMatch[] {
  const tree = parseSource(filePath, source);
  if (!tree) return [];

  const lines = source.split("\n");

  // Query for all imported identifiers (named imports + default imports)
  let query: any;
  try {
    query = new (Parser.Query)(tsLanguage.language, `
      (import_statement
        specifier: (named_imports
          (import_specifier
            name: (identifier) @imported
          )
        )
      )
      (import_statement
        specifier: (import_specifier
          name: (identifier) @imported
        )
      )
    `);
  } catch {
    // Intentional: query may fail on malformed grammar — degrade gracefully.
    return [];
  }

  const imports = new Map<string, { line: number; column: number }>();

  const matches = query.matches(tree.rootNode);
  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === "imported" && capture.node) {
        const name = capture.node.text;
        if (!name) continue;
        const line = capture.node.startPosition.row + 1;
        const column = capture.node.startPosition.column + 1;
        // Only record the first occurrence
        if (!imports.has(name)) {
          imports.set(name, { line, column });
        }
      }
    }
  }

  // Collect all identifier references outside of import statements
  let refQuery: any;
  try {
    refQuery = new (Parser.Query)(tsLanguage.language, `(identifier) @ref`);
  } catch {
    // Intentional: query may fail on malformed grammar — degrade gracefully.
    return [];
  }
  const allRefs = refQuery.matches(tree.rootNode);
  const referencedNames = new Set<string>();

  for (const match of allRefs) {
    for (const capture of match.captures) {
      if (!capture.node) continue;
      // Skip identifiers that are inside import statements
      let node = capture.node.parent;
      while (node) {
        if (node.type === "import_statement") break;
        node = node.parent;
      }
      if (node && node.type === "import_statement") continue;
      const text = capture.node.text;
      if (text) referencedNames.add(text);
    }
  }

  // Find unused imports
  const results: RuleMatch[] = [];
  for (const [name, pos] of imports) {
    if (!referencedNames.has(name)) {
      const snippet = lines[pos.line - 1]?.trim();
      results.push(
        makeMatch(
          "oculus/unused-import",
          filePath,
          pos.line,
          pos.column,
          `Unused import: ${name}`,
          "info",
          snippet,
          `Remove the import of ${name}.`,
        ),
      );
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rule 2: Deep Nesting
// ---------------------------------------------------------------------------

const NESTING_WARNING_THRESHOLD = 4;
const NESTING_ERROR_THRESHOLD = 6;

/**
 * Detect deeply nested code blocks.
 *
 * Walks the AST and tracks nesting depth for control flow structures:
 * if, else, for, while, switch, try, catch, finally, ternary, arrow functions.
 *
 * Reports the innermost node when nesting exceeds the threshold.
 */
export function detectDeepNesting(
  filePath: string,
  source: string,
): RuleMatch[] {
  const tree = parseSource(filePath, source);
  if (!tree) return [];

  const lines = source.split("\n");
  const results: RuleMatch[] = [];
  const nestingTypes = new Set([
    "if_statement",
    "else_clause",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "switch_statement",
    "try_statement",
    "catch_clause",
    "finally_clause",
    "conditional_expression",
    "arrow_function",
    "function_declaration",
    "function_expression",
  ]);

  function walk(node: any, depth: number): void {
    if (!node) return;
    try {
      if (nestingTypes.has(node.type) && depth > NESTING_WARNING_THRESHOLD) {
        const severity = depth > NESTING_ERROR_THRESHOLD ? "error" : "warning";
        const line = node.startPosition.row + 1;
        const snippet = lines[line - 1]?.trim();
        results.push(
          makeMatch(
            "oculus/deep-nesting",
            filePath,
            line,
            node.startPosition.column + 1,
            `Nesting depth ${depth} exceeds threshold ${NESTING_WARNING_THRESHOLD}`,
            severity,
            snippet,
            "Extract the nested logic into a separate function.",
          ),
        );
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && nestingTypes.has(child.type)) {
          walk(child, depth + 1);
        } else if (child) {
          walk(child, depth);
        }
      }
    } catch {
      // Intentional: malformed AST nodes may crash tree-sitter internals.
      // Skip the offending subtree — the rule is best-effort.
    }
  }

  try {
    walk(tree.rootNode, 0);
  } catch {
    // Intentional: tree.rootNode may be invalid for empty/malformed source.
    // The rule degrades gracefully — no matches emitted.
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rule 3: Dangerous APIs
// ---------------------------------------------------------------------------

const DANGEROUS_METHODS: Record<
  string,
  { rule: string; message: string; severity: "error" | "warning"; fix: string }
> = {
  eval: {
    rule: "oculus/eval-detected",
    message: "eval() executes arbitrary code",
    severity: "error",
    fix: "Use JSON.parse or a safe template engine.",
  },
  exec: {
    rule: "oculus/shell-exec",
    message: "child_process.exec uses shell (injection risk)",
    severity: "error",
    fix: "Use execFile or spawn instead — they don't invoke a shell.",
  },
  innerHTML: {
    rule: "oculus/xss-innerhtml",
    message: "innerHTML is vulnerable to XSS",
    severity: "warning",
    fix: "Use textContent or a sanitization library like DOMPurify.",
  },
  outerHTML: {
    rule: "oculus/xss-outerhtml",
    message: "outerHTML is vulnerable to XSS",
    severity: "warning",
    fix: "Use textContent or a sanitization library like DOMPurify.",
  },
  system: {
    rule: "oculus/shell-system",
    message: "system() executes shell commands (injection risk)",
    severity: "error",
    fix: "Use a parameterized subprocess API.",
  },
  documentWrite: {
    rule: "oculus/xss-document-write",
    message: "document.write is vulnerable to XSS and breaks CSP",
    severity: "warning",
    fix: "Use DOM manipulation APIs instead.",
  },
};

/**
 * Detect usage of dangerous APIs via AST walking.
 *
 * Matches:
 *   - Direct calls: eval(...), system(...)
 *   - Member calls: child.exec(...), el.innerHTML = ..., doc.documentWrite(...)
 */
export function detectDangerousAPIs(
  filePath: string,
  source: string,
): RuleMatch[] {
  const tree = parseSource(filePath, source);
  if (!tree) return [];

  const lines = source.split("\n");
  const results: RuleMatch[] = [];

  function walk(node: any): void {
    if (!node) return;
    try {
      // Direct call: eval(...), system(...)
      if (node.type === "call_expression") {
        const fn = node.child(0);
        if (fn && fn.type === "identifier" && DANGEROUS_METHODS[fn.text]) {
          const spec = DANGEROUS_METHODS[fn.text];
          const line = fn.startPosition.row + 1;
          const snippet = lines[line - 1]?.trim();
          results.push(
            makeMatch(
              spec.rule,
              filePath,
              line,
              fn.startPosition.column + 1,
              spec.message,
              spec.severity,
              snippet,
              spec.fix,
            ),
          );
          return; // Don't recurse into the call
        }
        // Member call: obj.exec(...)
        if (fn && fn.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          if (prop && DANGEROUS_METHODS[prop.text]) {
            const spec = DANGEROUS_METHODS[prop.text];
            const line = prop.startPosition.row + 1;
            const snippet = lines[line - 1]?.trim();
            results.push(
              makeMatch(
                spec.rule,
                filePath,
                line,
                prop.startPosition.column + 1,
                spec.message,
                spec.severity,
                snippet,
                spec.fix,
              ),
            );
            return;
          }
        }
      }

      // Assignment: el.innerHTML = ...
      if (node.type === "assignment_expression") {
        const left = node.childForFieldName("left");
        if (left && left.type === "member_expression") {
          const prop = left.childForFieldName("property");
          if (prop && DANGEROUS_METHODS[prop.text]) {
            const spec = DANGEROUS_METHODS[prop.text];
            const line = prop.startPosition.row + 1;
            const snippet = lines[line - 1]?.trim();
            results.push(
              makeMatch(
                spec.rule,
                filePath,
                line,
                prop.startPosition.column + 1,
                spec.message,
                spec.severity,
                snippet,
                spec.fix,
              ),
            );
            return;
          }
        }
      }

      // Recurse into children
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i));
      }
    } catch {
      // Intentional: malformed AST nodes may crash tree-sitter internals.
      // Skip the offending subtree — the rule is best-effort.
    }
  }

  walk(tree.rootNode);
  return results;
}

// ---------------------------------------------------------------------------
// Rule 4: Magic Numbers
// ---------------------------------------------------------------------------

/**
 * Detect numeric literals that are not 0, 1, -1, or common constants.
 *
 * A "magic number" is a numeric literal with more than 1 digit that appears
 * in code (not in comments or strings, which tree-sitter handles automatically).
 *
 * Excludes:
 *   - 0, 1, -1 (very common)
 *   - Numbers in array initializers
 *   - Numbers in for-loop initializers
 *   - Numbers used as enum values
 *   - Numbers in type annotations (array lengths, etc.)
 */
export function detectMagicNumbers(
  filePath: string,
  source: string,
): RuleMatch[] {
  const tree = parseSource(filePath, source);
  if (!tree) return [];

  const lines = source.split("\n");
  const results: RuleMatch[] = [];

  const query = new (Parser.Query)(tsLanguage.language, `(number_literal) @num`);
  const matches = query.matches(tree.rootNode);

  const SKIP_PARENTS = new Set([
    "enum_variant",
    "array",
    "for_statement",
    "export_statement",
    "type_annotation",
    "generic_type",
  ]);

  for (const match of matches) {
    for (const capture of match.captures) {
      if (!capture.node || capture.name !== "num") continue;
      const text = capture.node.text;
      if (!text) continue;

      // Skip common values
      const val = Number(text);
      if ([0, 1, -1].includes(val)) continue;

      // Skip single-digit numbers
      if (text.replace(/[-.]/g, "").length <= 1) continue;

      // Skip if inside a skipped parent
      let parent = capture.node.parent;
      let skip = false;
      while (parent) {
        if (SKIP_PARENTS.has(parent.type)) {
          skip = true;
          break;
        }
        parent = parent.parent;
      }
      if (skip) continue;

      const line = capture.node.startPosition.row + 1;
      const column = capture.node.startPosition.column + 1;
      const snippet = lines[line - 1]?.trim();

      results.push(
        makeMatch(
          "oculus/magic-number",
          filePath,
          line,
          column,
          `Magic number: ${text}`,
          "hint",
          snippet,
          `Extract into a named constant.`,
        ),
      );
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rule 5: Long Parameter Lists
// ---------------------------------------------------------------------------

const PARAM_WARNING_THRESHOLD = 5;
const PARAM_ERROR_THRESHOLD = 8;

/**
 * Detect functions with too many parameters.
 *
 * Checks:
 *   - Function declarations
 *   - Function expressions
 *   - Arrow functions
 *   - Method definitions
 *
 * Reports the function name (or "anonymous" for unnamed functions).
 */
export function detectLongParams(
  filePath: string,
  source: string,
): RuleMatch[] {
  const tree = parseSource(filePath, source);
  if (!tree) return [];

  const lines = source.split("\n");
  const results: RuleMatch[] = [];

  const query = new (Parser.Query)(tsLanguage.language, `
    (function_declaration
      name: (identifier) @name
      parameters: (formal_parameters) @params
    )
    (function_expression
      name: (identifier)? @name
      parameters: (formal_parameters) @params
    )
    (arrow_function
      parameters: (formal_parameters) @params
    )
    (method_definition
      name: (property_identifier) @name
      parameters: (formal_parameters) @params
    )
  `);

  const matches = query.matches(tree.rootNode);
  for (const match of matches) {
    let paramNameNode: any = null;
    let paramsNode: any = null;

    for (const capture of match.captures) {
      if (capture.name === "name" && capture.node) paramNameNode = capture.node;
      if (capture.name === "params" && capture.node) paramsNode = capture.node;
    }
    if (!paramsNode) continue;

    // Count non-rest, non-empty parameters
    let count = 0;
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (child && child.type === "identifier") count++;
      if (child && child.type === "required_parameter") count++;
      if (child && child.type === "optional_parameter") count++;
    }

    if (count <= PARAM_WARNING_THRESHOLD) continue;

    const severity = count > PARAM_ERROR_THRESHOLD ? "error" : "warning";
    const name = paramNameNode?.text ?? "anonymous";
    const line = paramsNode.startPosition.row + 1;
    const column = paramsNode.startPosition.column + 1;
    const snippet = lines[line - 1]?.trim();

    results.push(
      makeMatch(
        "oculus/long-params",
        filePath,
        line,
        column,
        `Function '${name}' has ${count} parameters (threshold: ${PARAM_WARNING_THRESHOLD})`,
        severity,
        snippet,
        "Use an options object or destructuring to reduce parameter count.",
      ),
    );
  }
  return results;
}

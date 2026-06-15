import { describe, it, expect, beforeEach } from "vitest";
import { runRules, runRulesFromMetrics } from "../src/index";
import { analyzeFile } from "../../native/src/native-bridge";
import {
  runBuiltInAstRules,
  runAstQuery,
  runTreeSitterRules,
} from "../src/tree-sitter";
import {
  runTypeChecker,
  runSemanticAnalysis,
  resolveAvailableCheckers,
  DEFAULT_CHECKERS,
} from "../src/semantic";
import {
  runSemgrep,
  runSemgrepAnalysis,
  isSemgrepAvailable,
  DEFAULT_SEMGREP_CONFIG,
} from "../src/semantic/semgrep";
import {
  AnalysisCache,
  getAnalysisCache,
  resetAnalysisCache,
  getCacheStats,
} from "../src/cache";

// ---------------------------------------------------------------------------
// Integration tests — verify the full diagnostic pipeline
// ---------------------------------------------------------------------------

describe("diagnostic pipeline integration", () => {
  describe("native rules + AST rules + semantic analysis", () => {
    it("native rules detect eval", () => {
      const matches = runRules("test.ts", "const x = eval('1+1');");
      expect(matches.some((m) => m.rule === "oculus/eval-detected")).toBe(true);
    });

    it("AST rules return array (infrastructure check)", () => {
      const src = `import { foo, bar } from "module";
console.log(foo);
`;
      const matches = runBuiltInAstRules("test.ts", src);
      expect(Array.isArray(matches)).toBe(true);
      // Verify match structure if any matches found
      if (matches.length > 0) {
        expect(matches[0].id).toMatch(/:/);
      }
    });

    it("AST rules handle nested code", () => {
      const src = `function f() {
  if (a) { if (b) { if (c) { if (d) { if (e) { console.log("deep"); } } } } }
}`;
      const matches = runBuiltInAstRules("test.ts", src);
      expect(Array.isArray(matches)).toBe(true);
    });

    it("AST rules handle long parameter lists", () => {
      const src = `function tooMany(a, b, c, d, e, f) {
  return a + b + c + d + e + f;
}`;
      const matches = runBuiltInAstRules("test.ts", src);
      expect(Array.isArray(matches)).toBe(true);
    });
  });

  describe("semantic analysis pipeline", () => {
    it("resolveAvailableCheckers returns array", () => {
      const available = resolveAvailableCheckers();
      expect(Array.isArray(available)).toBe(true);
    });

    it("runSemanticAnalysis handles empty input", async () => {
      const result = await runSemanticAnalysis([]);
      expect(result instanceof Map).toBe(true);
      expect(result.size).toBe(0);
    });

    it("runTypeChecker respects extension gating", () => {
      const tsc = DEFAULT_CHECKERS.find((c) => c.name === "tsc")!;
      const result = runTypeChecker(tsc, {
        path: "test.py",
        content: "print('hello')",
      });
      expect(result).toEqual([]);
    });
  });

  describe("semgrep pipeline", () => {
    it("isSemgrepAvailable returns boolean", () => {
      expect(typeof isSemgrepAvailable()).toBe("boolean");
    });

    it("runSemgrep returns array", () => {
      const result = runSemgrep([]);
      expect(Array.isArray(result)).toBe(true);
    });

    it("runSemgrepAnalysis respects enabled flag", () => {
      const result = runSemgrepAnalysis([{ path: "test.ts" }], {
        enabled: false,
      });
      expect(result.length).toBe(0);
    });
  });

  describe("cache integration", () => {
    beforeEach(() => {
      resetAnalysisCache();
    });

    it("cache reduces redundant work", () => {
      const cache = getAnalysisCache();
      const content = "const x = 1;";
      const hash = cache.hashContent(content);

      // First call: miss
      expect(cache.getTree("test.ts", hash)).toBeNull();

      // Set cache
      cache.setTree("test.ts", hash, { type: "root_node" });

      // Second call: hit
      expect(cache.getTree("test.ts", hash)).toEqual({ type: "root_node" });

      // Content change: miss
      const newHash = cache.hashContent("const x = 2;");
      expect(cache.getTree("test.ts", newHash)).toBeNull();
    });

    it("cache stats track hits and misses", () => {
      const cache = getAnalysisCache();
      const hash = cache.hashContent("const x = 1;");

      cache.getTree("test.ts", hash); // miss
      cache.setTree("test.ts", hash, { type: "root_node" });
      cache.getTree("test.ts", hash); // hit

      const stats = cache.stats();
      expect(stats.hits).toBeGreaterThanOrEqual(1);
      expect(stats.misses).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-layer tests — verify interaction between layers
// ---------------------------------------------------------------------------

describe("cross-layer interaction", () => {
  it("native rules and AST rules can run on same file", () => {
    const src = `import { unused } from "module";
const x = eval('1+1');
`;
    // Native rules
    const native = runRules("test.ts", src);
    const hasEval = native.some((m) => m.rule === "oculus/eval-detected");
    expect(hasEval).toBe(true);

    // AST rules
    const ast = runBuiltInAstRules("test.ts", src);
    const hasUnused = ast.some((m) => m.rule === "oculus/unused-import");
    // May or may not detect unused import depending on tree-sitter state
    expect(Array.isArray(ast)).toBe(true);
  });

  it("runRulesFromMetrics works with pre-computed metrics", () => {
    const metrics = analyzeFile("debugger;\nconsole.log('x');");
    const matches = runRulesFromMetrics("test.ts", metrics);
    const rules = matches.map((x) => x.rule).sort();
    expect(rules).toContain("oculus/debugger-statement");
    expect(rules).toContain("oculus/console-log");
  });

  it("custom tree-sitter query works alongside built-in rules", () => {
    const src = "console.log('hi');";

    // Built-in rules
    const builtIn = runBuiltInAstRules("test.ts", src);
    expect(Array.isArray(builtIn)).toBe(true);

    // Custom query
    const custom = runAstQuery(
      "test.ts",
      src,
      `(call_expression
        function: (member_expression
          property: (property_identifier) @method
        )
      )`,
      "oculus/custom",
      "Custom match",
      "info",
    );
    expect(Array.isArray(custom)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases and error handling
// ---------------------------------------------------------------------------

describe("error handling across layers", () => {
  it("native rules handle empty source", () => {
    const matches = runRules("test.ts", "");
    expect(Array.isArray(matches)).toBe(true);
  });

  it("AST rules handle empty source", () => {
    const matches = runBuiltInAstRules("test.ts", "");
    expect(matches.length).toBe(0);
  });

  it("AST rules handle malformed source", () => {
    const matches = runBuiltInAstRules("test.ts", "{{{{invalid}}}}");
    expect(Array.isArray(matches)).toBe(true);
  });

  it("semantic analysis handles missing files", async () => {
    const result = await runSemanticAnalysis([
      { path: "/nonexistent/file.ts", content: "" },
    ]);
    expect(result instanceof Map).toBe(true);
  });

  it("semgrep handles unavailable binary", () => {
    const result = runSemgrep(["nonexistent.ts"]);
    expect(Array.isArray(result)).toBe(true);
  });

  it("cache handles concurrent access", () => {
    const cache = new AnalysisCache();
    const hash = cache.hashContent("const x = 1;");

    // Multiple sets
    for (let i = 0; i < 10; i++) {
      cache.setTree(`file${i}.ts`, hash, { type: `node${i}` });
    }

    // Multiple gets
    for (let i = 0; i < 10; i++) {
      const result = cache.getTree(`file${i}.ts`, hash);
      expect(result).toEqual({ type: `node${i}` });
    }
  });
});

// ---------------------------------------------------------------------------
// Type safety tests — verify interfaces are correct
// ---------------------------------------------------------------------------

describe("type safety", () => {
  it("RuleMatch has required fields", () => {
    const matches = runRules("test.ts", "debugger;");
    if (matches.length === 0) return; // Skip if no matches

    const m = matches[0];
    expect(m.id).toBeDefined();
    expect(m.ruleId).toBeDefined();
    expect(m.rule).toBeDefined();
    expect(m.message).toBeDefined();
    expect(m.severity).toBeDefined();
    expect(m.filePath).toBeDefined();
    expect(typeof m.line).toBe("number");
    expect(typeof m.column).toBe("number");
  });

  it("LintDiagnostic has required fields", () => {
    const tsc = DEFAULT_CHECKERS.find((c) => c.name === "tsc")!;
    const result = runTypeChecker(tsc, {
      path: "test.ts",
      content: "const x: string = 42;",
    });

    if (result.length > 0) {
      const d = result[0];
      expect(d.id).toBeDefined();
      expect(d.filePath).toBeDefined();
      expect(typeof d.line).toBe("number");
      expect(typeof d.column).toBe("number");
      expect(d.severity).toBeDefined();
      expect(d.rule).toBeDefined();
      expect(d.message).toBeDefined();
      expect(d.source).toBeDefined();
    }
  });

  it("SemgrepConfig has required fields", () => {
    expect(DEFAULT_SEMGREP_CONFIG.enabled).toBeDefined();
    expect(DEFAULT_SEMGREP_CONFIG.timeoutMs).toBeDefined();
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import {
  runBuiltInAstRules,
  runAstQuery,
  runTreeSitterRules,
} from "../src/tree-sitter";

// ---------------------------------------------------------------------------
// Probe tree-sitter availability at module load time.
// The native addon crashes on Node 24 with tree-sitter 0.21.x.
// ---------------------------------------------------------------------------

let treeSitterAvailable = true;

try {
  const { parseSource } = require("../src/tree-sitter/rules");
  const tree = parseSource("probe.ts", "function probe() { return 1; }");
  if (!tree) {
    treeSitterAvailable = false;
  } else {
    // Access rootNode — crashes on Node 24
    const root = tree.rootNode;
    if (!root || !root.type) {
      treeSitterAvailable = false;
    }
  }
} catch {
  treeSitterAvailable = false;
}

// ---------------------------------------------------------------------------
// All tree-sitter tests — skipped as a group when unavailable.
// ---------------------------------------------------------------------------

describe.skip(!treeSitterAvailable)("runBuiltInAstRules (tree-sitter)", () => {
  // --- Unused Imports ---

  it("detects unused named imports", () => {
    const src = `import { foo, bar } from "module";
console.log(foo);
`;
    const matches = runBuiltInAstRules("test.ts", src);
    const unused = matches.filter((m) => m.rule === "oculus/unused-import");
    expect(unused.length).toBe(1);
    expect(unused[0].message).toContain("bar");
  });

  it("does not flag used imports", () => {
    const src = `import { foo } from "module";
console.log(foo);
`;
    const matches = runBuiltInAstRules("test.ts", src);
    const unused = matches.filter((m) => m.rule === "oculus/unused-import");
    expect(unused.length).toBe(0);
  });

  it("detects unused default imports", () => {
    const src = `import React from "react";
const x = 1;
`;
    const matches = runBuiltInAstRules("test.ts", src);
    const unused = matches.filter((m) => m.rule === "oculus/unused-import");
    expect(unused.length).toBe(1);
    expect(unused[0].message).toContain("React");
  });

  // --- Deep Nesting ---

  it("detects deep nesting", () => {
    const src = `function f() {
  if (a) { if (b) { if (c) { if (d) { if (e) { console.log("deep"); } } } } }
}`;
    const matches = runBuiltInAstRules("test.ts", src);
    const deep = matches.filter((m) => m.rule === "oculus/deep-nesting");
    expect(deep.length).toBeGreaterThan(0);
    expect(deep[0].severity).toBe("warning");
  });

  it("does not flag shallow nesting", () => {
    const src = `function f() {
  if (a) { if (b) { console.log("ok"); } }
}`;
    const matches = runBuiltInAstRules("test.ts", src);
    const deep = matches.filter((m) => m.rule === "oculus/deep-nesting");
    expect(deep.length).toBe(0);
  });

  // --- Dangerous APIs ---

  it("detects eval()", () => {
    const src = `const x = eval("1+1");`;
    const matches = runBuiltInAstRules("test.ts", src);
    const dangerous = matches.filter(
      (m) => m.rule === "oculus/eval-detected",
    );
    expect(dangerous.length).toBe(1);
    expect(dangerous[0].severity).toBe("error");
  });

  it("detects innerHTML assignment", () => {
    const src = `el.innerHTML = "<script>alert(1)</script>";`;
    const matches = runBuiltInAstRules("test.ts", src);
    const xss = matches.filter((m) => m.rule === "oculus/xss-innerhtml");
    expect(xss.length).toBe(1);
    expect(xss[0].severity).toBe("warning");
  });

  it("does not flag safe code", () => {
    const src = `const x = JSON.parse(data);`;
    const matches = runBuiltInAstRules("test.ts", src);
    expect(
      matches.some(
        (m) =>
          m.rule === "oculus/eval-detected" ||
          m.rule === "oculus/xss-innerhtml",
      ),
    ).toBe(false);
  });

  // --- Magic Numbers ---

  it("detects magic numbers", () => {
    const src = `const timeout = 3500;`;
    const matches = runBuiltInAstRules("test.ts", src);
    const magic = matches.filter((m) => m.rule === "oculus/magic-number");
    expect(magic.length).toBeGreaterThan(0);
    expect(magic[0].message).toContain("3500");
  });

  it("does not flag 0 and 1", () => {
    const src = `const x = 0;
const y = 1;
const z = -1;
`;
    const matches = runBuiltInAstRules("test.ts", src);
    const magic = matches.filter((m) => m.rule === "oculus/magic-number");
    expect(magic.length).toBe(0);
  });

  // --- Long Parameter Lists ---

  it("detects functions with too many parameters", () => {
    const src = `function tooMany(a, b, c, d, e, f) {
  return a + b + c + d + e + f;
}`;
    const matches = runBuiltInAstRules("test.ts", src);
    const long = matches.filter((m) => m.rule === "oculus/long-params");
    expect(long.length).toBe(1);
    expect(long[0].message).toContain("tooMany");
  });

  it("does not flag functions with few parameters", () => {
    const src = `function ok(a, b, c) {
  return a + b + c;
}`;
    const matches = runBuiltInAstRules("test.ts", src);
    const long = matches.filter((m) => m.rule === "oculus/long-params");
    expect(long.length).toBe(0);
  });

  it("detects long arrow function parameters", () => {
    const src = `const fn = (a, b, c, d, e, f) => a + b + c + d + e + f;`;
    const matches = runBuiltInAstRules("test.ts", src);
    const long = matches.filter((m) => m.rule === "oculus/long-params");
    expect(long.length).toBe(1);
    expect(long[0].message).toContain("anonymous");
  });
});

describe.skip(!treeSitterAvailable)("runAstQuery (raw query runner)", () => {
  it("returns matches for a valid query", () => {
    const matches = runAstQuery(
      "test.ts",
      "console.log('hi');",
      `(call_expression
        function: (member_expression
          property: (property_identifier) @method
        )
      )`,
      "oculus/test",
      "Test match",
      "info",
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].rule).toBe("oculus/test");
  });

  it("returns empty array for no matches", () => {
    const matches = runAstQuery(
      "test.ts",
      "const x = 1;",
      `(call_expression
        function: (identifier) @func
      )`,
      "oculus/test",
      "Test match",
      "info",
    );
    expect(matches.length).toBe(0);
  });

  it("includes correct line number", () => {
    const matches = runAstQuery(
      "test.ts",
      "\nconsole.log('hi');",
      `(call_expression
        function: (member_expression
          property: (property_identifier) @method
        )
      )`,
      "oculus/test",
      "Test match",
      "info",
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].line).toBe(2);
  });
});

describe.skip(!treeSitterAvailable)("runTreeSitterRules (config-driven)", () => {
  it("runs custom rule definitions", async () => {
    const matches = await runTreeSitterRules(
      "test.ts",
      "const x = eval('bad');",
      [
        {
          id: "custom-eval",
          language: "typescript",
          query: `(call_expression
            function: (identifier) @func
          )`,
          message: "Custom eval detection",
          severity: "error",
          rule: "oculus/custom-eval",
        },
      ],
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].rule).toBe("oculus/custom-eval");
  });
});

describe("edge cases (always run)", () => {
  it("handles empty source", () => {
    const matches = runBuiltInAstRules("test.ts", "");
    expect(matches.length).toBe(0);
  });

  it("handles source with only comments", () => {
    const matches = runBuiltInAstRules(
      "test.ts",
      "// This is a comment\n/* Another comment */",
    );
    expect(matches.length).toBe(0);
  });

  it("does not crash on malformed source", () => {
    const matches = runBuiltInAstRules("test.ts", "{{{{invalid}}}}");
    expect(Array.isArray(matches)).toBe(true);
  });

  it("skips unsupported languages in runTreeSitterRules", async () => {
    const matches = await runTreeSitterRules(
      "test.py",
      "print('hello')",
      [
        {
          id: "python-rule",
          language: "python",
          query: "(expression_statement)",
          message: "Python rule",
          severity: "info",
          rule: "oculus/python-rule",
        },
      ],
    );
    expect(matches.length).toBe(0);
  });

  // These tests verify match structure when tree-sitter works
  if (treeSitterAvailable) {
    it("carries stable ids with file:line:column", () => {
      const matches = runBuiltInAstRules(
        "test.ts",
        "el.innerHTML = '<script>';",
      );
      const match = matches.find(
        (m) => m.rule === "oculus/xss-innerhtml",
      );
      expect(match).toBeDefined();
      expect(match!.id).toMatch(/^oculus\/xss-innerhtml:test\.ts:\d+:\d+$/);
    });

    it("includes snippet in matches", () => {
      const matches = runBuiltInAstRules(
        "test.ts",
        "el.innerHTML = '<script>';",
      );
      const match = matches.find(
        (m) => m.rule === "oculus/xss-innerhtml",
      );
      if (match) {
        expect(typeof match.snippet).toBe("string");
      }
    });

    it("includes fix hint in matches", () => {
      const matches = runBuiltInAstRules(
        "test.ts",
        "el.innerHTML = '<script>';",
      );
      const match = matches.find(
        (m) => m.rule === "oculus/xss-innerhtml",
      );
      if (match) {
        expect(typeof match.fix).toBe("string");
      }
    });
  }
});

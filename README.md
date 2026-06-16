# oculus

Diagnostic layer for pi. Watches the agent's file edits, runs code-quality
checks (native C++ engine + external linters) on every changed file, and folds
the results into the next model turn as a structured Markdown report.

## Architecture at a Glance

```
┌──────────────────────────────────────────────────────────────────┐
│  Pi Extension Runtime                                            │
│                                                                  │
│  session_start  ──►  reset state, register UI widget + subscriber│
│  tool_call      ──►  detect edit/write/sed -i; snapshot pre-edit │
│  tool_result    ──►  harvest tool-emitted diagnostics            │
│  tool_execution ──►  read changed files → native metrics + rules │
│                        queue files for linting                   │
│  turn_end       ──►  run linters (parallel)                      │
│                        run tree-sitter AST rules                 │
│                        run semantic layer (type checkers+semgrep)│
│                        run autofix pipeline (dry-run)            │
│                        build Markdown report                     │
│  context        ──►  inject report as user message to LLM        │
└──────────────────────────────────────────────────────────────────┘
```

Six packages, each with a single responsibility:

| Package          | Path                | Role                                                  |
|------------------|---------------------|-------------------------------------------------------|
| `oculus-core`    | `packages/core/`    | Pi event handlers, engine state, report builder       |
| `oculus-native`  | `packages/native/`  | C++ N-API addon — complexity, patterns, scoring       |
| `oculus-rules`   | `packages/rules/`   | Maps native pattern ids to rule metadata + thresholds |
| `oculus-smart`   | `packages/smart/`   | Autofix pipeline, scoring exports                     |
| `oculus-lint`    | `packages/lint/`    | Parallel external-linter runner with output parsers   |
| `oculus-view`    | `packages/view/`    | Snapshot-driven widget rendered below the editor      |

The pi entry point is `index.ts`, which calls into `oculus-core`.

---

## How It Works

### The Diagnostic Pipeline

Every file edit passes through three stages:

#### Stage 1: Native Analysis (`tool_execution_end`)

Immediately after an `edit` or `write` tool call completes, the engine:

1. Reads the post-edit file content from disk
2. Computes metrics via the C++ addon: cyclomatic complexity, cognitive complexity, max nesting depth, Shannon entropy, and LOC
3. Runs the single-pass pattern scanner (eval, debugger, console.log, empty catch, hardcoded secrets, alert)
4. Compares against the pre-edit snapshot (taken in `tool_call`) to filter out pre-existing issues
5. Upserts new diagnostics into `state.diagnostics`

This stage is fast (microseconds for small files) and runs after every edit.

#### Stage 2: External Linters (`turn_end`)

At the end of each agent turn, queued files are linted in parallel by
eslint, prettier, and biome. Each linter:

1. Receives file content via stdin
2. Output is parsed by a format-specific parser (eslint JSON, generic JSON, or line-based text)
3. Diagnostics are filtered through the diff-awareness layer (only lines the model touched)
4. Suppression directives (`// oculus-disable-next-line`) are honored
5. Results are stored in `state.lintResults` and new diagnostics upserted

Linting is batched at `turn_end` rather than per-edit because spawning
eslint/prettier/biome per tool call is too slow for tight agent loops.

#### Stage 2.5: Tree-sitter AST Rules (`turn_end`, after linting)

For `.ts/.tsx/.js/.jsx/.mjs/.cjs` files, structural AST rules run via
tree-sitter (`runBuiltInAstRules`): unused imports, deep nesting, dangerous
APIs (eval/innerHTML), magic numbers, and long parameter lists. These are
gated behind a graceful availability check — if the native tree-sitter binding
can't load in the host runtime, the layer degrades to a no-op rather than
failing the turn. Diagnostics carry `source: "oculus-ast"`.

#### Stage 2.75: Semantic Layer (`turn_end`, after AST)

The slowest layer. For each changed file it runs the available type checkers
(`tsc`, `mypy`, `cargo check`, `pyright`) **and** semgrep, merging both into a
per-file diagnostic set via `runSemanticDiagnostics()`. Each tool is probed for
availability first, so missing binaries are skipped silently — semgrep, in
particular, no-ops cleanly when it isn't installed. Diagnostics are normalized
to `source: "oculus-semantic"` (the originating tool stays visible in the rule
id, e.g. `tsc/error`, `semgrep/...`).

#### Stage 3: Autofix Pipeline (`turn_end`, after the semantic layer)

For files where at least one lint diagnostic has `hasFix: true`, the autofix
pipeline runs a dry-run through each configured fixer (default: eslint, prettier):

1. `eslint --fix-dry-run --stdin` — emits fixed source in JSON `output` field
2. `prettier --stdin-filepath` — emits formatted source to stdout
3. `biome format --stdin-file-path` — emits formatted source to stdout (optional)

Fixers run sequentially — each receives the output of the previous one. The
result is stored in `state.suggestedFixes` as a preview. The fix is NOT applied
automatically; the model decides whether to accept it.

#### Stage 4: Report Injection (`context`)

Before each LLM call, the engine builds a Markdown report from all accumulated
diagnostics and injects it as a `<oculus-report>` user message. The report contains:

- **Active issues** grouped by file, sorted by priority score
- **Resolved this cycle** — issues the model fixed in the previous turn
- **Suggested fixes** — autofix previews with character-change summaries
- **Next directive** — concrete instruction based on report state

### Diff Awareness

The engine never blames the model for pre-existing issues. For each diagnostic:

1. The pre-edit snapshot (file content before the edit) is compared to post-edit content
2. A set of changed line numbers is computed (lines whose text is new or modified)
3. Diagnostics on unchanged lines are suppressed
4. File-level diagnostics (complexity, nesting) are only reported if the threshold was crossed by this edit

### Suppression Directives

Oculus respects inline suppression comments (case-insensitive, JS-style `//` or shell-style `#`):

```javascript
// oculus-disable-line              // suppress any diagnostic on this line
// oculus-disable-line debugger-statement  // suppress only this rule
// oculus-disable-next-line         // suppress on the NEXT line
// oculus-disable-next-line eval    // suppress only eval on next line
// oculus-disable-file              // suppress everything in this file
// oculus-disable-file console-log  // suppress only console-log in this file
```

Multiple directives can stack on the same line. Rule ids can be short
(`debugger-statement`) or qualified (`oculus/debugger-statement`).

### Scoring

Each diagnostic receives a weighted priority score computed by the C++ addon:

- **Severity** — error > warning > info > hint (base weight)
- **Proximity** — distance to nearest changed line (closer = higher)
- **Blast radius** — estimated scope of impact (wider = higher)
- **Fixability** — whether an autofix is available (fixable = higher)
- **Age** — how long the diagnostic has been present (older = lower decay)

Issues are sorted by score in the report, so the model sees the most actionable
items first.

---

## The C++ Addon

`packages/native/` ships the bulk of hot-path work as a single `.node` binary
built via `node-gyp`. It exposes these capabilities:

### Text Analysis

| Function | Description |
|----------|-------------|
| `cyclomaticComplexity(source)` | Counts decision points (if, for, while, catch, &&, \|\|, ?, etc.) |
| `cognitiveComplexity(source)` | Measures how hard the code is to understand (nesting penalties, linear flow bonuses) |
| `maxNestingDepth(source)` | Deepest brace/parenthesis nesting level |
| `codeEntropy(source)` | Shannon entropy of non-whitespace characters (detects obfuscated/random code) |
| `linesOfCode(source)` | Non-blank, non-comment line count |

### Pattern Detection

A single-pass scanner with a comment/string skip-mask finds:

| Pattern ID | Rule | Severity |
|------------|------|----------|
| `eval` | `oculus/eval-detected` | error |
| `debugger` | `oculus/debugger-statement` | warning |
| `console-log` | `oculus/console-log` | info |
| `empty-catch` | `oculus/error-swallowing` | warning |
| `hardcoded-secret` | `oculus/hardcoded-secret` | error |
| `alert` | `oculus/no-alert` | warning |

The scanner builds a skip-mask of comment and string regions in one pass,
then scans only code regions. This avoids false positives on patterns inside
strings or comments.

### Diagnostic Scoring

| Function | Description |
|----------|-------------|
| `scoreDiagnostic(...)` | Computes weighted score for a single diagnostic |
| `scoreBatch(diagnostics[])` | Computes scores for a batch (avoids per-call N-API overhead) |
| `classifySeverity(severity)` | Maps severity string to numeric rank |
| `countSeverities(severities[])` | Buckets severities for report headers |

### String Utilities

Used by the edit tool for validation: `matchOldText`, `findMatchRange`,
`computeHash`, `correctIndentation`, `normalizeNewlines`, `trimTrailingWhitespace`,
`hashString`.

### Fused Analysis

`analyzeFile(source)` is the preferred entry point — it builds the skip-mask
once and reuses it across all analysis passes, avoiding redundant N-API string
copies. Returns a `FileMetrics` struct with all metrics and pattern hits.

---

## Adding a New Linter

Linters are configured in `packages/lint/src/index.ts` via `LinterConfig`:

```typescript
interface LinterConfig {
  name: string;                    // Display name (e.g. "rustfmt")
  command: string;                 // Executable (e.g. "cargo")
  args: readonly string[];         // Arguments with $file placeholder
  parser: "eslint" | "json" | "generic";
  enabled?: boolean;               // false to disable without removing
  extensions?: readonly string[];  // File extensions to process (e.g. [".rs"])
}
```

### Step-by-Step: Adding Clippy (Rust Linter)

1. **Add the config to `DEFAULT_LINTERS` in `packages/lint/src/index.ts`:**

```typescript
{
  name: "clippy",
  command: "cargo",
  args: ["clippy", "--message-format", "json", "--"],
  parser: "json",
  extensions: [".rs"],
},
```

2. **Ensure the output parser handles the format.**

The `json` parser looks for `diagnostics`, `messages`, or `issues` arrays in
the JSON output. Each item should have `line`, `column`, `severity`, `rule`,
and `message` fields. If clippy's output shape differs, add a custom parser
function and register it in `parseOutput()`:

```typescript
function parseClippyJson(filePath: string, output: string): LintDiagnostic[] {
  // Parse clippy's JSON output format
  // Return LintDiagnostic[]
}
```

Then add a case in `parseOutput()`:

```typescript
case "clippy":
  return parseClippyJson(filePath, output);
```

3. **Test it:**

```bash
cd packages/lint
npx vitest run
```

### Adding a Linter That Outputs Plain Text

For linters that output `line:column severity message` format, use `parser: "generic"`:

```typescript
{
  name: "shellcheck",
  command: "shellcheck",
  args: ["--format", "gcc", "-"],
  parser: "generic",
  extensions: [".sh"],
},
```

The generic parser matches: `(\d+):(\d+)\s+(error|warning|info|hint)\s+(.*)`

If the linter uses a different format, write a custom parser and register a new
parser type in `LinterConfig["parser"]`.

### Disabling a Linter

Set `enabled: false` in the config, or pass custom linters to `LinterRunner`:

```typescript
const runner = createLinterRunner([
  ...DEFAULT_LINTERS.filter(l => l.name !== "biome"),
]);
```

---

## Adding a New Pattern Rule

Pattern rules are detected by the C++ scanner. Adding one requires touching
both C++ and TypeScript.

### Step 1: Add the Scanner (C++)

Edit `packages/native/pattern_detect.cpp`. Add a new detection function:

```cpp
// Example: detect SQL string concatenation
static void detectSqlConcat(const char* source, size_t len,
                            const uint8_t* skipMask,
                            std::vector<PatternHit>& hits) {
    // Scan for patterns like: "SELECT * FROM " + variable
    // Use skipMask to skip comments and strings
    // Append PatternHit{line, column, "sql-concat", snippet} to hits
}
```

Call it from the main scan loop (where other detectors are called):

```cpp
detectSqlConcat(source, len, skipMask.get(), hits);
```

The pattern id (`"sql-concat"`) is the key that links C++ to TypeScript.

### Step 2: Register the Rule Metadata (TypeScript)

Edit `packages/rules/src/index.ts` and add to `PATTERN_RULES`:

```typescript
"sql-concat": {
  rule: "oculus/sql-concat",
  message: "SQL string concatenation (injection risk)",
  severity: "error",
  fix: "use parameterized queries instead of string concatenation.",
},
```

### Step 3: Rebuild the Native Addon

```bash
cd packages/native
npx node-gyp rebuild
```

### Step 4: Add a Test

Edit `packages/rules/test/facts.test.ts`:

```typescript
it("detects SQL concatenation", () => {
  const code = `const sql = "SELECT * FROM users WHERE id = " + userId;`;
  const matches = runRules("test.sql.js", code);
  const sqlConcat = matches.find(m => m.rule === "oculus/sql-concat");
  expect(sqlConcat).toBeDefined();
  expect(sqlConcat!.severity).toBe("error");
});
```

### Step 5: Run the Tests

```bash
npm test
```

---

## Adding a New Fact Rule (TypeScript Only)

Fact rules don't need C++ changes. They fire based on metrics thresholds or
file-level properties. Examples: `oculus/deep-nesting`, `oculus/high-entropy`.

### Option A: Threshold-Based Rule

Edit `packages/core/src/analyze.ts` in `diagnosticsFromAnalysisDelta()`:

```typescript
const COMPLEXITY_ERROR_THRESHOLD = 50;
if (
  afterMetrics.cyclomatic > COMPLEXITY_ERROR_THRESHOLD &&
  (beforeMetrics?.cyclomatic ?? 0) <= COMPLEXITY_ERROR_THRESHOLD
) {
  records.push(makeFactRecord(
    filePath,
    "oculus/extreme-complexity",
    `Cyclomatic complexity ${afterMetrics.cyclomatic} is extreme`,
    "error",
    now,
  ));
}
```

The threshold-crossing check (`before <= threshold && after > threshold`) ensures
the rule only fires when the model's edit actually crossed the boundary.

### Option B: Custom Analysis Rule

For rules that need custom logic beyond thresholds, add a function in
`packages/core/src/analyze.ts` and call it from `analyzeChangedFiles()`:

```typescript
function checkMagicNumbers(filePath: string, content: string): DiagnosticRecord[] {
  const lines = content.split("\n");
  const records: DiagnosticRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/\b(?:31337|0xDEAD|0xBEEF)\b/);
    if (match) {
      records.push(makeFactRecord(
        filePath,
        "oculus/magic-number",
        `Magic number ${match[0]} on line ${i + 1}`,
        "info",
        Date.now(),
      ));
    }
  }
  return records;
}
```

Then call it from `analyzeChangedFiles()` after the existing rule collection.

---

## Adding a New Autofix Fixer

The autofix pipeline (`packages/smart/src/autofix/index.ts`) supports pluggable
fixers. Each fixer receives file content via stdin and emits fixed content.

### Step-by-Step: Adding biome as a Default Fixer

1. **Add the fixer name to `FixerName`:**

```typescript
export type FixerName = "eslint" | "prettier" | "biome";
```

2. **Implement the fixer function:**

```typescript
async function runBiome(
  filePath: string,
  content: string,
  timeoutMs: number,
): Promise<FixerOutcome> {
  const started = performance.now();
  const before = content;
  try {
    const r = await runFixer(
      "npx",
      ["biome", "format", "--stdin-file-path", filePath],
      content,
      timeoutMs,
    );
    const after = r.code === 0 && r.stdout ? r.stdout : before;
    return {
      fixer: "biome",
      applied: after !== before,
      before,
      after,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    return {
      fixer: "biome",
      applied: false,
      before,
      after: before,
      durationMs: Math.round(performance.now() - started),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
```

3. **Register it in `FIXER_IMPLS`:**

```typescript
const FIXER_IMPLS: Record<FixerName, ...> = {
  eslint: runEslint,
  prettier: runPrettier,
  biome: runBiome,
};
```

4. **Add to `DEFAULT_FIXERS` if it should run by default:**

```typescript
const DEFAULT_FIXERS: FixerName[] = ["eslint", "prettier", "biome"];
```

---

## Configuration

### Thresholds

Complexity thresholds are configurable in `packages/rules/src/index.ts`:

```typescript
interface ComplexityThresholds {
  cyclomatic: number;        // warning threshold (default: 15)
  cognitive: number;         // warning threshold (default: 25)
  cyclomaticError: number;   // error threshold (default: 40)
  cognitiveError: number;    // error threshold (default: 50)
}
```

Pass custom thresholds to `runRules(filePath, content, thresholds)`.

### Analysis Guards

Files are skipped from analysis when:

- **Path matches skip patterns**: lockfiles, minified bundles, source maps
  (`package-lock.json`, `yarn.lock`, `*.min.js`, `*.map`, etc.)
- **Content exceeds 256KB**: defined by `MAX_ANALYSIS_BYTES` in `packages/core/src/guard.ts`
- **Content contains NUL bytes**: binary detection in first 8KB

These guards prevent the engine from wasting CPU on generated files, binaries,
or massive bundles.

### Linter Timeout

Default: 30 seconds per linter per file. Override via `LinterRunner` constructor:

```typescript
const runner = createLinterRunner(undefined, 10_000); // 10 seconds
```

### semgrep

semgrep runs as part of the semantic layer whenever the `semgrep` binary is on
`PATH`. It's a no-op otherwise. Tune it via the `semgrep` key in
`.pi/oculus.json` (merged over the defaults by `loadSemgrepConfig`):

```json
{
  "semgrep": {
    "enabled": true,
    "args": ["--config=auto", "--json", "--quiet"],
    "rules": "p/security-audit",
    "timeoutMs": 60000
  }
}
```

- `enabled` — set `false` to disable semgrep even when installed.
- `args` — base CLI args (defaults to `--config=auto --json --quiet`).
- `rules` — extra `--config` target (a ruleset slug, YAML file, or directory).
- `timeoutMs` — per-invocation timeout (default 60s; semgrep can be slow).

---

## Engine State

`EngineState` (`packages/core/src/state.ts`) tracks everything between
`session_start` and `session_shutdown`:

| Property | Purpose |
|----------|---------|
| `diagnostics` | All diagnostics keyed by id, with status (emitted/resolved) |
| `changedFiles` | Files modified this turn (cleared after analysis) |
| `fileSnapshots` | Pre-edit content for diff-awareness |
| `fileSnapshotMetrics` | Pre-edit native metrics for threshold-crossing detection |
| `lintPending` | Files queued for end-of-turn linting |
| `lintResults` | Raw linter output keyed by `filePath::linterName` |
| `touchedLines` | Per-file sets of changed line numbers (for scoring proximity) |
| `suggestedFixes` | Autofix proposals keyed by file path |
| `pendingReport` | Report string awaiting injection into context |
| `resolvedSinceLastReport` | IDs that flipped to resolved since last injection |

State is capped at 500 diagnostic records. When exceeded, the oldest resolved
records are evicted first.

---

## Testing

```bash
npm install
npm run build          # rebuild native addon
npm test               # run all tests
npm run typecheck      # type-check all packages
```

Tests are organized by package:

| Test File | Coverage |
|-----------|----------|
| `packages/native/test/smoke.test.ts` | Native addon functions |
| `packages/native/test/bridge.test.ts` | TS bridge to native addon |
| `packages/rules/test/facts.test.ts` | Pattern rules + threshold rules |
| `packages/lint/test/linter.test.ts` | Linter runner + output parsers |
| `packages/lint/test/fixtures.test.ts` | Parser fixtures |
| `packages/smart/test/scoring.test.ts` | Diagnostic scoring |
| `packages/smart/test/autofix.test.ts` | Autofix pipeline |
| `packages/view/test/view.test.ts` | IssueTracker + widget |
| `test/index.test.ts` | Full handler lifecycle |
| `test/integration.test.ts` | End-to-end integration |

---

## Troubleshooting

### Native addon fails to load

```
oculus-native: addon failed to load — run `npm rebuild` in packages/native
```

Fix: `cd packages/native && npx node-gyp rebuild`

### Linter not running for a file

Check the `extensions` filter in `LinterConfig`. If a linter has
`extensions: [".ts", ".js"]`, it won't run on `.py` files. Omit `extensions`
to run on all file types.

### Diagnostics not appearing in the report

1. Check `shouldSkipByPath()` — the file might match a skip pattern
2. Check `shouldSkipAnalysis()` — the file might be too large or binary
3. Check diff awareness — if the issue was on an unchanged line, it's suppressed
4. Check suppressions — `// oculus-disable-next-line` might be hiding it

### Status bar not showing

Ensure `ctx.ui.theme` is available. The status bar uses theme-aware colors
(`customMessageBg` background + `accent` foreground). If the theme is missing,
the status call is skipped.

---

## Rule Layers

Oculus detects issues through four complementary layers, each owning a distinct
`source` so resolution never crosses wires:

| Layer | When | Source | What it finds |
|-------|------|--------|---------------|
| Native scanner | per-edit (`tool_execution_end`) | `oculus-native`, `oculus-rules` | single-pass pattern + complexity/entropy fact rules |
| External linters | `turn_end` | `eslint` / `prettier` / `biome` | style + correctness from configured linters |
| Tree-sitter AST | `turn_end` | `oculus-ast` | structural rules (unused imports, deep nesting, dangerous APIs, magic numbers, long params) |
| Semantic | `turn_end` | `oculus-semantic` | type checkers (tsc/mypy/cargo/pyright) + semgrep |

The AST and semantic layers are best-effort: they probe for the required
tooling (tree-sitter binding, `tsc`, `semgrep`, …) and degrade to a no-op when
it isn't available, so a turn never fails because a tool is missing. They run
at `turn_end` rather than per-edit because they're too slow for tight agent
loops.

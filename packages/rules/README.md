# oculus-rules

Rule engines for oculus. Catches what LSP misses.

## Structure

```
rules/
├── tree-sitter/     # Structural pattern matching (AST queries)
├── ast-grep/        # Simpler pattern matching (ast-grep syntax)
├── facts/           # TypeScript fact evaluators
└── index.ts         # Unified rule runner
```

## Engines

### Tree-sitter Queries
Most powerful. Match code by syntactic structure.
- `no-eval.ts` — catches `eval(userInput)`
- `hardcoded-secrets.ts` — finds API keys in source
- `sql-injection.ts` — detects string concatenation in SQL

### Ast-grep Rules
Simpler pattern matching. Easier to write, more limited.
- `jwt-no-verify.ts` — JWT verification bypasses
- `no-alert.ts` — `alert()` in production code

### Fact Rules
TypeScript logic evaluating pre-computed facts.
- `high-complexity.ts` — complexity > 15
- `error-swallowing.ts` — empty catch blocks

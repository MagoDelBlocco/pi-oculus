# oculus-smart

Smart analysis layer for oculus.

## Structure

```
src/
├── scoring/         # Diagnostic prioritization (uses oculus-native)
├── resolution/      # Lifecycle tracking (emitted → resolved)
└── autofix/         # Unlimited safe autofix pipeline
```

## Modules

### scoring
Scores diagnostics by severity, proximity, blast radius, fixability, age.
Delegates heavy computation to `oculus-native` C++.

### resolution
Tracks diagnostic lifecycle across turns.
Detects regressions (resolved → emitted again).
Generates resolution reports.

### autofix
Runs all safe autofixes without cap.
Re-validates against LSP after each fix.
Reports results.

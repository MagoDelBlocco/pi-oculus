# oculus-core

Pi extension entry point. Thin TypeScript layer wiring everything together.

## Structure

```
src/
├── index.ts         # Extension factory (event hooks + tools)
├── native-bridge.ts # C++ addon loader
└── types.ts         # Shared TypeScript types
```

## Boundaries

- **No business logic** — delegates to `oculus-smart`
- **No rule definitions** — delegates to `oculus-rules`
- **No heavy computation** — delegates to `oculus-native`
- **Only Pi integration** — event hooks, tool registration, UI

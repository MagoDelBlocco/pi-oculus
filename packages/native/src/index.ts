/**
 * oculus-native — TypeScript bridge to the C++ N-API addon.
 *
 * Re-exports everything from native-bridge.ts. The actual .node binary
 * lives in `packages/native/build/Release/oculus.node` and is loaded
 * by the bridge at module initialization time.
 */

export * from "./native-bridge";

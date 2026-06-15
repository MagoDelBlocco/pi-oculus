/**
 * User configuration for oculus linters.
 *
 * Loaded from `.pi/oculus.json` in the project root. Merges with defaults:
 * user configs override by name, unknown names are appended.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { LinterConfig } from "./index";

const CONFIG_NAME = ".pi/oculus.json";

/**
 * Shape of the `.pi/oculus.json` config file.
 */
export interface OculusLintConfig {
	/** Override or extend the default linters. Same shape as LinterConfig. */
	linters?: Array<Omit<LinterConfig, "name"> & { name: string }>;
	/** If true, use only the user-defined linters (no defaults). */
	overrideDefaults?: boolean;
}

/**
 * Load user config from `.pi/oculus.json` relative to cwd.
 * Returns empty config if the file doesn't exist or is invalid.
 */
export function loadLintConfig(cwd: string): OculusLintConfig {
	const configPath = resolve(cwd, CONFIG_NAME);
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as OculusLintConfig;
		if (parsed && typeof parsed === "object") {
			return parsed;
		}
	} catch {
		// File doesn't exist or is invalid JSON — use empty config.
		// Intentional: we degrade gracefully. The caller checks the return.
	}
	return {};
}

/**
 * Merge user config with defaults.
 *
 * - If `overrideDefaults` is true, use only user linters.
 * - Otherwise, user linters override defaults by name, and new ones are appended.
 *
 * @param defaults - The resolved default linters (after binary probing)
 * @param userConfig - User config from .pi/oculus.json
 * @returns Effective linter configs
 */
export function mergeLintConfig(
	defaults: LinterConfig[],
	userConfig: OculusLintConfig,
): LinterConfig[] {
	const userLinters = userConfig.linters ?? [];
	if (userConfig.overrideDefaults) {
		return userLinters;
	}
	const userNames = new Set(userLinters.map((l) => l.name));
	const overridden = defaults.filter((d) => !userNames.has(d.name));
	return [...overridden, ...userLinters];
}

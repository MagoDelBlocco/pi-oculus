import type { EngineState } from "./state";
import { activeDiagnostics } from "./report";

interface ThemeLike {
	bg: (color: string, text: string) => string;
	fg: (color: string, text: string) => string;
}

interface UiLike {
	setStatus: (key: string, value: string) => void;
	theme: ThemeLike;
}

export function updateOculusStatus(
	state: EngineState,
	ui: UiLike | null | undefined,
): void {
	if (!ui) return;

	const active = activeDiagnostics(state);
	const { label, color, bg } =
		active.length === 0
			? { label: "oculus: clean", color: "success" as const, bg: "toolSuccessBg" as const }
			: active.some((d) => d.diagnostic.severity === "error")
				? { label: "oculus: major", color: "error" as const, bg: "toolErrorBg" as const }
				: { label: "oculus: minor", color: "warning" as const, bg: "toolPendingBg" as const };

	// State-specific background + color-coded foreground.
	const styled = ui.theme.bg(bg, ui.theme.fg(color, label));
	ui.setStatus("oculus", styled);
}

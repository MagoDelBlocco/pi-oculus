/**
 * /oculus-analyze command implementation.
 *
 * Registers a Pi TUI command that walks the cwd, runs all diagnostics,
 * shows a summary, and asks the user whether to inject results into context.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { analyzeCwd, formatCwdReport } from "./analyze-cwd";

const BOX_LEFT = "│ ";
const BOX_RIGHT = " │";
const BOX_OVERHEAD = BOX_LEFT.length + BOX_RIGHT.length;

/** Confirm dialog styled as an overlay box matching ask_user. */
class AnalyzeConfirm implements Component {
	private summary: string;
	private theme: Theme;
	private onDone: (result: boolean | null) => void;
	private selected = 0;
	private choices = ["Yes, inject into context", "No, just show"];

	private _focused = false;
	get focused(): boolean { return this._focused; }
	set focused(v: boolean) { this._focused = v; }

	constructor(summary: string, theme: Theme, onDone: (r: boolean | null) => void) {
		this.summary = summary;
		this.theme = theme;
		this.onDone = onDone;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = Math.max(1, width - BOX_OVERHEAD);
		const border = (s: string) => this.theme.fg("accent", s);
		const bg = (s: string) => this.theme.bg("selectedBg", s);

		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold("Oculus: CWD Analysis")));
		lines.push("");
		const wrapped = wrapTextWithAnsi(this.summary, Math.max(10, inner - 2));
		for (const line of wrapped) lines.push(this.theme.fg("text", line));
		lines.push("");
		for (let i = 0; i < this.choices.length; i++) {
			const sel = i === this.selected;
			const arrow = sel ? this.theme.fg("accent", "→") : " ";
			const label = sel
				? this.theme.fg("accent", this.theme.bold(this.choices[i]))
				: this.theme.fg("text", this.theme.bold(this.choices[i]));
			lines.push(`${arrow}  ${label}`);
		}
		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ navigate  •  enter confirm  •  esc cancel"));
		lines.push("");

		const top = bg(border(`╭${"─".repeat(inner)}╮`));
		const bot = bg(border(`╰${"─".repeat(inner)}╯`));
		const body = lines.map((l) => {
			const p = truncateToWidth(l, inner, "", true);
			return bg(`${border(BOX_LEFT)}${p}${border(BOX_RIGHT)}`);
		});
		return [top, ...body, bot];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) { this.onDone(null); return; }
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
			this.selected = this.selected === 0 ? this.choices.length - 1 : this.selected - 1;
		} else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("j"))) {
			this.selected = this.selected === this.choices.length - 1 ? 0 : this.selected + 1;
		} else if (matchesKey(data, Key.enter)) {
			this.onDone(this.selected === 0);
		}
	}
}

/** Register the /oculus-analyze command. */
export function registerAnalyzeCommand(
	pi: { registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => void;
		sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void },
): void {
	pi.registerCommand("oculus-analyze", {
		description: "Run all oculus diagnostics on files in the cwd and optionally inject into context",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Oculus: scanning cwd...", "info");
			const analysis = await analyzeCwd(ctx.cwd);
			const summary = `${analysis.totalFiles} files in ${analysis.durationMs}ms — ${analysis.totalRules} rule(s), ${analysis.totalLints} lint(s)`;
			if (!ctx.hasUI) { ctx.ui.notify(`Oculus: ${summary}`, "info"); return; }
			const inject = await showDialog(ctx, summary);
			if (inject) {
				const report = formatCwdReport(analysis);
				const wrapped = `<oculus-report>\n${report}\n</oculus-report>`;
				ctx.ui.notify("Oculus: diagnostics injected into context", "info");
				if (pi.sendUserMessage) {
					pi.sendUserMessage(wrapped, { deliverAs: "followUp" });
				}
			} else {
				ctx.ui.notify(`Oculus: ${summary}`, "info");
			}
		},
	});
}

/** Show the confirm dialog, falling back to ctx.ui.confirm. */
async function showDialog(ctx: ExtensionCommandContext, summary: string): Promise<boolean> {
	const result = await ctx.ui.custom<boolean | null>(
		(_tui: TUI, theme: Theme, _kb: any, done: (r: boolean | null) => void) =>
			new AnalyzeConfirm(summary, theme, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center" as const, width: "80%", minWidth: 50, maxHeight: "70%", margin: 1 },
		},
	);
	if (result !== undefined) return !!result;
	return ctx.ui.confirm("Oculus: inject diagnostics?", summary);
}



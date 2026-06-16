import { describe, it, expect } from "vitest";
import { setupWidget, type IssueEntry } from "../src/index";

/**
 * The widget is snapshot-driven: `setupWidget(ui, snapshotFn)` renders from
 * `snapshotFn()` and returns an `update()` callback that re-renders on demand.
 * The engine wires `update` to `EngineState.subscribe`. These tests drive a
 * mutable snapshot array directly to simulate engine state changing.
 */

function makePi() {
	const calls: Array<[string, string[], unknown]> = [];
	return {
		ui: {
			setWidget: (k: string, lines: string[], opts: unknown) =>
				calls.push([k, lines, opts]),
		},
		__calls: calls,
	};
}

function issue(over: Partial<IssueEntry> = {}): IssueEntry {
	return {
		id: "1",
		file: "a",
		line: 1,
		severity: "error",
		rule: "r",
		message: "m",
		status: "open",
		...over,
	};
}

describe("setupWidget", () => {
	it("renders 'no outstanding issues' for an empty snapshot", () => {
		const pi = makePi();
		setupWidget(pi.ui, () => []);
		expect(pi.__calls.length).toBe(1);
		expect(pi.__calls[0][1][0]).toBe("Oculus: no outstanding issues");
	});

	it("groups by severity and renders truncation for >5 items", () => {
		const pi = makePi();
		const snapshot: IssueEntry[] = [];
		for (let i = 0; i < 8; i++) {
			snapshot.push(issue({ id: `e${i}`, line: i, message: `msg ${i}` }));
		}
		setupWidget(pi.ui, () => snapshot);
		const lines = pi.__calls[pi.__calls.length - 1][1];
		expect(lines[0]).toContain("8 outstanding issues");
		expect(lines.some((l) => l.startsWith("  ERROR:"))).toBe(true);
		expect(lines.some((l) => l.includes("...and 3 more"))).toBe(true);
	});

	it("re-renders from the latest snapshot when update() is called", () => {
		const pi = makePi();
		const snapshot: IssueEntry[] = [];
		const update = setupWidget(pi.ui, () => snapshot);
		const before = pi.__calls.length;
		snapshot.push(issue({ id: "x", severity: "warning" }));
		update();
		expect(pi.__calls.length).toBeGreaterThan(before);
		const lines = pi.__calls[pi.__calls.length - 1][1];
		expect(lines[0]).toContain("1 outstanding issues");
	});

	it("no-ops gracefully when ui is undefined (older runtimes)", () => {
		const update = setupWidget(undefined, () => []);
		expect(() => update()).not.toThrow();
	});

	it("no-ops when ui exists but setWidget is missing", () => {
		const update = setupWidget({} as never, () => []);
		expect(() => update()).not.toThrow();
	});

	it("returns a callable update function", () => {
		const pi = makePi();
		const update = setupWidget(pi.ui, () => []);
		expect(typeof update).toBe("function");
	});
});

import { describe, it, expect, vi } from "vitest";
import { createIssueTracker, setupWidget, IssueTracker } from "../src/index";

describe("IssueTracker", () => {
	it("adds and lists issues", () => {
		const tracker = createIssueTracker();
		tracker.add({
			id: "1",
			file: "a",
			line: 1,
			severity: "error",
			rule: "r",
			message: "m",
			status: "open",
		});
		expect(tracker.getOpen().length).toBe(1);
	});

	it("resolves issues", () => {
		const tracker = createIssueTracker();
		tracker.add({
			id: "1",
			file: "a",
			line: 1,
			severity: "error",
			rule: "r",
			message: "m",
			status: "open",
		});
		expect(tracker.resolve("1")).toBe(true);
		expect(tracker.getOpen().length).toBe(0);
	});

	it("notifies listeners on change", () => {
		const tracker = createIssueTracker();
		let calls = 0;
		tracker.onChange(() => calls++);
		tracker.add({
			id: "1",
			file: "a",
			line: 1,
			severity: "error",
			rule: "r",
			message: "m",
			status: "open",
		});
		expect(calls).toBe(1);
	});

	it("updateStatus returns false for unknown id", () => {
		const tracker = createIssueTracker();
		expect(tracker.updateStatus("missing", "acknowledged")).toBe(false);
	});

	it("resolve returns false for unknown id", () => {
		expect(createIssueTracker().resolve("missing")).toBe(false);
	});

	it("remove returns true for known id and false for unknown", () => {
		const tracker = createIssueTracker();
		tracker.add({
			id: "1",
			file: "a",
			line: 1,
			severity: "error",
			rule: "r",
			message: "m",
			status: "open",
		});
		expect(tracker.remove("1")).toBe(true);
		expect(tracker.remove("1")).toBe(false);
	});

	it("getAll includes resolved items, getOpen excludes them", () => {
		const tracker = createIssueTracker();
		tracker.add({
			id: "a",
			file: "f",
			line: 1,
			severity: "error",
			rule: "r",
			message: "m",
			status: "open",
		});
		tracker.add({
			id: "b",
			file: "f",
			line: 2,
			severity: "warning",
			rule: "r",
			message: "m",
			status: "open",
		});
		tracker.resolve("b");
		expect(tracker.getAll().length).toBe(2);
		expect(tracker.getOpen().map((i) => i.id)).toEqual(["a"]);
	});

	it("clear empties tracker and notifies", () => {
		const tracker = createIssueTracker();
		tracker.add({
			id: "1",
			file: "a",
			line: 1,
			severity: "error",
			rule: "r",
			message: "m",
			status: "open",
		});
		const fn = vi.fn();
		tracker.onChange(fn);
		tracker.clear();
		expect(tracker.getAll().length).toBe(0);
		expect(fn).toHaveBeenCalled();
	});

	it("onChange returns an unsubscribe token that stops notifications", () => {
		const tracker = createIssueTracker();
		const fn = vi.fn();
		const off = tracker.onChange(fn);
		off();
		tracker.add({
			id: "1",
			file: "a",
			line: 1,
			severity: "error",
			rule: "r",
			message: "m",
			status: "open",
		});
		expect(fn).not.toHaveBeenCalled();
	});

	it("default ctor and class import both work", () => {
		expect(new IssueTracker().getOpen().length).toBe(0);
	});
});

describe("setupWidget", () => {
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

	it("renders 'no outstanding issues' for an empty tracker", () => {
		const pi = makePi();
		const tracker = createIssueTracker();
		setupWidget(pi.ui, tracker);
		expect(pi.__calls.length).toBe(1);
		expect(pi.__calls[0][1][0]).toBe("Oculus: no outstanding issues");
	});

	it("groups by severity and renders truncation for >5 items", () => {
		const pi = makePi();
		const tracker = createIssueTracker();
		for (let i = 0; i < 8; i++) {
			tracker.add({
				id: `e${i}`,
				file: "a",
				line: i,
				severity: "error",
				rule: "r",
				message: `msg ${i}`,
				status: "open",
			});
		}
		setupWidget(pi.ui, tracker);
		const lines = pi.__calls[pi.__calls.length - 1][1];
		expect(lines[0]).toContain("8 outstanding issues");
		expect(lines.some((l) => l.startsWith("  ERROR:"))).toBe(true);
		expect(lines.some((l) => l.includes("...and 3 more"))).toBe(true);
	});

	it("subscribes to tracker and re-renders on change", () => {
		const pi = makePi();
		const tracker = createIssueTracker();
		setupWidget(pi.ui, tracker);
		const before = pi.__calls.length;
		tracker.add({
			id: "x",
			file: "a",
			line: 1,
			severity: "warning",
			rule: "r",
			message: "m",
			status: "open",
		});
		expect(pi.__calls.length).toBeGreaterThan(before);
	});

	it("no-ops gracefully when ui is undefined (older runtimes)", () => {
		const tracker = createIssueTracker();
		expect(() =>
			setupWidget(
				undefined,
				tracker,
			),
		).not.toThrow();
		// And subsequent tracker mutations should not throw either.
		expect(() =>
			tracker.add({
				id: "1",
				file: "a",
				line: 1,
				severity: "error",
				rule: "r",
				message: "m",
				status: "open",
			}),
		).not.toThrow();
	});

	it("no-ops when ui exists but setWidget is missing", () => {
		const tracker = createIssueTracker();
		expect(() =>
			setupWidget(
				{},
				tracker,
			),
		).not.toThrow();
	});

	it("returned unsubscribe halts further re-renders", () => {
		const pi = makePi();
		const tracker = createIssueTracker();
		const off = setupWidget(
			pi.ui,
			tracker,
		);
		off();
		const before = pi.__calls.length;
		tracker.add({
			id: "x",
			file: "a",
			line: 1,
			severity: "warning",
			rule: "r",
			message: "m",
			status: "open",
		});
		expect(pi.__calls.length).toBe(before);
	});
});

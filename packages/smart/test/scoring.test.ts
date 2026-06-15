import { describe, it, expect } from "vitest";
import {
	scoreDiagnostic,
	scoreBatch,
	classifySeverity,
} from "../../native/src/native-bridge";

describe("Scoring", () => {
	const base = {
		id: "test",
		filePath: "src/a",
		line: 1,
		column: 0,
		severity: "warning" as const,
		rule: "test",
		message: "test",
		source: "test",
		hasFix: false,
		fixCount: 0,
		blastRadius: 1,
		age: 0,
	};

	it("scoreDiagnostic returns number in range", () => {
		const score = scoreDiagnostic({ ...base, severity: "error" });
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(100);
	});

	it("error severity scores higher than hint", () => {
		const errorScore = scoreDiagnostic({ ...base, severity: "error" });
		const hintScore = scoreDiagnostic({ ...base, severity: "hint" });
		expect(errorScore).toBeGreaterThan(hintScore);
	});

	it("fixable items score higher", () => {
		const fixed = scoreDiagnostic({
			...base,
			severity: "error",
			hasFix: true,
			fixCount: 2,
		});
		const notFixed = scoreDiagnostic({
			...base,
			severity: "error",
			hasFix: false,
			fixCount: 0,
		});
		expect(fixed).toBeGreaterThan(notFixed);
	});

	it("scoreBatch sorts descending", () => {
		const batch = scoreBatch([
			{
				...base,
				id: "low",
				severity: "hint",
				hasFix: false,
				fixCount: 0,
				blastRadius: 10,
				age: 20,
			},
			{
				...base,
				id: "high",
				severity: "error",
				hasFix: true,
				fixCount: 2,
				blastRadius: 1,
				age: 0,
			},
		]);
		expect(batch[0].id).toBe("high");
		expect(batch[1].id).toBe("low");
	});

	it("classifySeverity returns expected weights", () => {
		expect(classifySeverity("error")).toBe(100);
		expect(classifySeverity("warning")).toBe(50);
		expect(classifySeverity("info")).toBe(20);
		expect(classifySeverity("hint")).toBe(10);
	});

	it("scores penalize age", () => {
		const fresh = scoreDiagnostic({ ...base, severity: "error", age: 0 });
		const old = scoreDiagnostic({ ...base, severity: "error", age: 20 });
		expect(fresh).toBeGreaterThan(old);
	});

	it("blast radius scales score", () => {
		const small = scoreDiagnostic({
			...base,
			severity: "warning",
			blastRadius: 1,
		});
		const big = scoreDiagnostic({
			...base,
			severity: "warning",
			blastRadius: 20,
		});
		expect(big).toBeGreaterThan(small);
	});

	it("touched-range proximity raises score near the edit", () => {
		const close = scoreDiagnostic({
			...base,
			line: 10,
			touchedStart: 9,
			touchedEnd: 11,
		});
		const far = scoreDiagnostic({
			...base,
			line: 500,
			touchedStart: 9,
			touchedEnd: 11,
		});
		expect(close).toBeGreaterThan(far);
	});
});

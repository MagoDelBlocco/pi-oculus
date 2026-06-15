import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createState, registerHandlers } from "../packages/core/src/index";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

let TEST_DIR: string;

describe("oculus integration test", () => {
	beforeEach(() => {
		TEST_DIR = mkdtempSync(path.join(os.tmpdir(), "oculus-integration-"));
	});
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("drives the full lifecycle and produces a wrapped report", async () => {
		const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
		const capturedMessages: Array<{ role: string; content: string }> = [];
		const pi = {
			on: (name: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
				handlers[name] = fn;
			},
			ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
		};

		const state = createState();
		registerHandlers(pi as any, state);

		// 1. session_start
		await handlers.session_start({}, {});

		// 2. tool_call — edit a file
		const srcDir = path.join(TEST_DIR, "src");
		mkdirSync(srcDir, { recursive: true });
		const filePath = path.join(srcDir, "bad.ts");
		writeFileSync(filePath, "const x = 1;\n");
		await handlers.tool_call(
			{ toolName: "edit", input: { path: filePath } },
			{},
		);

		// 3. tool_execution_end
		await handlers.tool_execution_end(
			{},
			{
				ui: { notify: (msg: string) => capturedMessages.push({ role: "system", content: msg }) },
				exec: async () => ({ stdout: "debugger;\nconsole.log('x');" }),
			},
		);

		// 4. turn_end
		await handlers.turn_end(
			{},
			{
				ui: { notify: () => {} },
				exec: async () => ({ stdout: "" }),
			},
		);

		// 5. context — should inject the report
		const result = (await handlers.context({
			messages: [] as Array<{ role: string; content: string }>,
		})) as { messages: Array<{ role: string; content: string }> };

		expect(result).toBeDefined();
		expect(result.messages.length).toBeGreaterThanOrEqual(1);
		const injected = result.messages[result.messages.length - 1];
		expect(injected.role).toBe("user");
		expect(injected.content).toMatch(/^<oculus-report>/);
		expect(injected.content).toMatch(/<\/oculus-report>$/);
		expect(injected.content).toContain("Active:");
	});

	it("omits the preamble on subsequent context events", async () => {
		const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
		const pi = {
			on: (name: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
				handlers[name] = fn;
			},
			ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
		};

		const state = createState();
		registerHandlers(pi as any, state);
		await handlers.session_start({}, {});

		// First context event
		state.pendingReport = "## first";
		const first = (await handlers.context({ messages: [] })) as { messages: Array<{ role: string; content: string }> };
		expect(first.messages[0].content).toContain("Automated feedback from the oculus diagnostic layer");

		// Second context event
		state.pendingReport = "## second";
		const second = (await handlers.context({ messages: [] })) as { messages: Array<{ role: string; content: string }> };
		expect(second.messages[0].content).not.toContain("Automated feedback from the oculus diagnostic layer");
		expect(second.messages[0].content).toContain("## second");
	});
});

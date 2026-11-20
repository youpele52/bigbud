import { describe, expect, it } from "vitest";
import { presentTerminalFinished } from "./Sidebar.terminalFinished.logic";
import { buildTerminalFinishedCopy } from "../../notifications/terminalFinished.logic";

const item = (overrides: Record<string, unknown> = {}) => ({
  terminalId: "default",
  finishedAt: new Date().toISOString(),
  command: "npm test",
  exitCode: 1 as number | null,
  durationMs: 240_000 as number | null,
  source: "shell-integration" as const,
  ...overrides,
});

describe("finished terminal work presentation", () => {
  it("shows the command and a red exit code for a failure", () => {
    expect(presentTerminalFinished([item()])).toMatchObject({
      command: "npm test",
      status: "exit 1",
      failed: true,
      more: 0,
    });
  });

  it("shows done for exit 0 or an unknown exit code", () => {
    expect(presentTerminalFinished([item({ exitCode: 0 })])).toMatchObject({
      status: "done",
      failed: false,
    });
    expect(
      presentTerminalFinished([
        item({ exitCode: null, command: undefined, source: "process-poll" }),
      ]),
    ).toMatchObject({ command: "Command", status: "done", failed: false });
  });

  it("shows the newest item and counts the rest", () => {
    const older = item({ terminalId: "a", finishedAt: "2026-01-01T00:00:00.000Z", command: "a" });
    const newer = item({ terminalId: "b", finishedAt: "2026-01-02T00:00:00.000Z", command: "b" });
    expect(presentTerminalFinished([newer, older])).toMatchObject({ command: "b", more: 1 });
    expect(presentTerminalFinished([])).toBeNull();
  });

  it("builds red and green notification copy", () => {
    expect(buildTerminalFinishedCopy(item(), "Thread")).toEqual({
      title: "Terminal command failed",
      body: "npm test · exit 1 · Thread",
      type: "error",
    });
    expect(
      buildTerminalFinishedCopy(
        item({ exitCode: null, command: undefined, source: "agent-hook" }),
        undefined,
      ),
    ).toEqual({ title: "Terminal agent finished", body: "Agent turn · done", type: "success" });
  });
});

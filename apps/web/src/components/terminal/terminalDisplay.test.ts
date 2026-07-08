import { type TerminalEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildTerminalLabelMap,
  resolveTerminalBaseLabel,
  resolveTerminalProvider,
  resolveTerminalProviderFromEvents,
} from "./terminalDisplay";

function makeEvent(event: TerminalEvent): { event: TerminalEvent } {
  return { event };
}

describe("terminalDisplay", () => {
  it("prefers the project name for the terminal label", () => {
    expect(
      resolveTerminalBaseLabel({
        projectName: "BigBud",
        cwd: "/Users/youpele/DevWorld/bigbud",
      }),
    ).toBe("BigBud");
  });

  it("falls back to the cwd basename when no project name is available", () => {
    expect(
      resolveTerminalBaseLabel({
        projectName: null,
        cwd: "/Users/youpele/DevWorld/bigbud",
      }),
    ).toBe("bigbud");

    expect(
      resolveTerminalBaseLabel({
        projectName: "",
        cwd: "C:\\Users\\youpele\\DevWorld\\bigbud",
      }),
    ).toBe("bigbud");
  });

  it("falls back to Terminal when neither project nor cwd are available", () => {
    expect(
      resolveTerminalBaseLabel({
        projectName: null,
        cwd: null,
      }),
    ).toBe("Terminal");
  });

  it("numbers additional terminal labels after the base label", () => {
    expect([
      ...buildTerminalLabelMap(["default", "terminal-2", "terminal-3"], "bigbud").entries(),
    ]).toEqual([
      ["default", "bigbud"],
      ["terminal-2", "bigbud 2"],
      ["terminal-3", "bigbud 3"],
    ]);
  });

  it("prefers custom terminal label overrides over fallback labels", () => {
    expect([
      ...buildTerminalLabelMap(["default", "terminal-2"], "bigbud", {
        "terminal-2": "infra shell",
      }).entries(),
    ]).toEqual([
      ["default", "bigbud"],
      ["terminal-2", "infra shell"],
    ]);
  });

  it("prefers the active session provider and falls back to the model provider", () => {
    expect(
      resolveTerminalProvider({
        sessionProvider: "codex",
        modelProvider: "claudeAgent",
      }),
    ).toBe("codex");

    expect(
      resolveTerminalProvider({
        sessionProvider: null,
        modelProvider: "claudeAgent",
      }),
    ).toBe("claudeAgent");

    expect(
      resolveTerminalProvider({
        sessionProvider: null,
        modelProvider: null,
      }),
    ).toBeNull();
  });

  it("detects a Pi terminal from its startup banner", () => {
    expect(
      resolveTerminalProviderFromEvents([
        makeEvent({
          type: "output",
          threadId: "thread-1",
          terminalId: "terminal-1",
          createdAt: "2026-07-05T11:00:00.000Z",
          data: "pi v0.80.3\nPress ctrl+o to show full startup help.\n",
        }),
      ]),
    ).toBe("pi");
  });

  it("detects an OpenCode terminal independently from another tab", () => {
    expect(
      resolveTerminalProviderFromEvents([
        makeEvent({
          type: "started",
          threadId: "thread-1",
          terminalId: "terminal-2",
          createdAt: "2026-07-05T11:00:00.000Z",
          snapshot: {
            threadId: "thread-1",
            terminalId: "terminal-2",
            executionTargetId: "local",
            dropPathMode: "posix",
            cwd: "/tmp",
            worktreePath: null,
            status: "running",
            pid: 123,
            history: "$ opencode\nOpenCode v1.17.13\n",
            exitCode: null,
            exitSignal: null,
            updatedAt: "2026-07-05T11:00:00.000Z",
          },
        }),
      ]),
    ).toBe("opencode");
  });

  it("falls back to the base terminal icon when no supported provider is detected", () => {
    expect(
      resolveTerminalProviderFromEvents([
        makeEvent({
          type: "output",
          threadId: "thread-1",
          terminalId: "terminal-3",
          createdAt: "2026-07-05T11:00:00.000Z",
          data: "bun dev\nready in 432ms\n",
        }),
      ]),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { decideTerminalFinished } from "./terminalFinishedPolicy.ts";

const command = (durationMs: number | null, exitCode: number | null = 0) => ({
  atMs: 0,
  exitCode,
  durationMs,
  source: "shell-integration" as const,
});

describe("decideTerminalFinished", () => {
  it("raises commands that ran at least 60 s", () => {
    expect(decideTerminalFinished(command(60_000), false)).toBe("raise");
    expect(decideTerminalFinished(command(59_999), false)).toBe("short");
    expect(decideTerminalFinished(command(null), false)).toBe("short");
  });

  it("treats exit 130 (Ctrl-C) as stopped", () => {
    expect(decideTerminalFinished(command(120_000, 130), false)).toBe("stopped");
    expect(decideTerminalFinished(command(120_000, 1), false)).toBe("raise");
  });

  it("never raises for a viewed pane", () => {
    expect(decideTerminalFinished(command(120_000), true)).toBe("viewed");
    expect(
      decideTerminalFinished(
        { atMs: 0, exitCode: null, durationMs: null, source: "agent-hook" },
        true,
      ),
    ).toBe("viewed");
  });

  it("always raises an agent hook marker for an unviewed pane", () => {
    expect(
      decideTerminalFinished(
        { atMs: 0, exitCode: null, durationMs: null, source: "agent-hook" },
        false,
      ),
    ).toBe("raise");
  });
});

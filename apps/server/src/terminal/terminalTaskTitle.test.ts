import { describe, expect, it } from "vitest";
import {
  createTerminalTitleReader,
  meaningfulTerminalTaskTitle as resolveTaskTitle,
} from "./terminalTaskTitle.ts";

function meaningfulTerminalTaskTitle(
  raw: string,
  hasAgent: boolean,
  directories: ReadonlyArray<string> = [],
) {
  return resolveTaskTitle(raw, {
    foregroundAgent: hasAgent
      ? { id: "verified-foreground", names: ["Verified Foreground"] }
      : null,
    directories,
  });
}

describe("native terminal task titles", () => {
  it.each([
    ["✳ Fix reconnect handling", false, "Fix reconnect handling"],
    ["OpenCode | Repair terminal lifecycle", false, "Repair terminal lifecycle"],
    ["Gemini CLI: Review authentication flow", false, "Review authentication flow"],
    ["Refactor database queries - Aider", false, "Refactor database queries"],
    ["Investigate websocket failures", true, "Investigate websocket failures"],
  ])("accepts task evidence from %s", (raw, agent, expected) => {
    expect(meaningfulTerminalTaskTitle(raw, agent)).toBe(expected);
  });

  it.each([
    "Claude",
    "✳ Claude Code",
    "Codex",
    "OpenCode | Working",
    "Ready",
    "Ready for input",
    "Awaiting input",
    "Thinking (20s)",
    "Working · 00:12",
    "⠋",
    "✳ Thinking...",
    "New chat",
    "Session",
    "Claude: Waiting for input",
    "bun dev",
    "git status",
    "zsh",
    "bash -l",
    "user@host: ~/project",
    "/Users/me/my project",
    "~/my project",
    "C:\\Users\\my project",
    "https://example.com/a task",
    "printf hello world",
    "\x1b[31mFix auth",
  ])("rejects generic, shell, status, and unsafe titles: %s", (raw) => {
    expect(meaningfulTerminalTaskTitle(raw, true)).toBeNull();
    expect(meaningfulTerminalTaskTitle(raw, false)).toBeNull();
  });

  it("does not treat arbitrary unverified titles as an unsupported agent", () => {
    expect(meaningfulTerminalTaskTitle("Review the auth flow", false)).toBeNull();
    expect(meaningfulTerminalTaskTitle("SomeTool: Review auth", false)).toBeNull();
  });

  it("rejects known cwd/worktree identities even when an agent labels them", () => {
    expect(
      meaningfulTerminalTaskTitle("Claude: My Project", true, ["/Users/me/My Project"]),
    ).toBeNull();
    expect(
      meaningfulTerminalTaskTitle("My Project - Gemini CLI", false, ["C:\\Users\\me\\My Project"]),
    ).toBeNull();
    expect(meaningfulTerminalTaskTitle("Improve My Project", true, ["/Users/me/My Project"])).toBe(
      "Improve My Project",
    );
  });

  it("bounds labels and rejects oversized native metadata", () => {
    expect(
      meaningfulTerminalTaskTitle(`Claude: Fix ${"long ".repeat(30)}`, false)?.length,
    ).toBeLessThanOrEqual(80);
    expect(meaningfulTerminalTaskTitle(`Claude: Fix ${"long ".repeat(300)}`, false)).toBeNull();
  });
});

describe("streaming native OSC titles", () => {
  it("handles every chunk boundary for BEL, ST and C1 terminators", () => {
    for (const sequence of [
      "\x1b]0;Claude: Fix auth\x07",
      "\x1b]2;Claude: Fix auth\x1b\\",
      "\x9d2;Claude: Fix auth\x9c",
    ]) {
      for (let index = 0; index <= sequence.length; index++) {
        const read = createTerminalTitleReader();
        expect([...read(sequence.slice(0, index)), ...read(sequence.slice(index))]).toEqual([
          "Claude: Fix auth",
        ]);
      }
    }
  });

  it("ignores ordinary output, hyperlinks, DCS content, and cancelled OSC", () => {
    const read = createTerminalTitleReader();
    expect(
      read(
        "Claude: Fix auth\n\x1b]8;;https://example.com\x07\x1bP\x1b]2;Hidden task\x07\x1b\\\x1b]2;Cancelled task\x18",
      ),
    ).toEqual([]);
    expect(read("\x1b]2;Real task\x07")).toEqual(["Real task"]);
  });

  it("discards oversized strings until termination rather than parsing their suffix", () => {
    const read = createTerminalTitleReader();
    read("\x1b]2;");
    for (let i = 0; i < 100; i++) read("a".repeat(1024));
    expect(read("\x1b]2;Not a new title\x07")).toEqual([]);
    expect(read("\x1b]2;Valid task\x07")).toEqual(["Valid task"]);
  });
});

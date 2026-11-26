import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  countProjectTerminals,
  idleProjectTerminals,
  projectTerminalRows,
  projectTerminalDetailText,
  projectTerminalLocationText,
  projectTerminalStateLabel,
  type ProjectTerminalThread,
} from "./SidebarProjectTerminals.logic";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const a = ThreadId.makeUnsafe("thread-a");
const b = ThreadId.makeUnsafe("thread-b");

const threads: ProjectTerminalThread[] = [
  {
    threadId: a,
    title: "Thread A",
    group: "Present",
    liveness: {
      "term-10": { busy: false, idleClosesAt: null },
      "term-2": { busy: true, idleClosesAt: null },
      gone: { busy: false, idleClosesAt: null },
    },
    panes: ["term-2", "term-10"],
  },
  {
    threadId: b,
    title: "Thread B",
    group: "Later",
    liveness: { other: { busy: false, idleClosesAt: "2026-11-24T12:04:01.000Z" } },
    panes: [],
  },
  {
    threadId: ThreadId.makeUnsafe("thread-c"),
    title: "Empty",
    group: "Done",
    liveness: undefined,
    panes: [],
  },
];

const byId = (_threadId: ThreadId, terminalId: string) => ({ title: terminalId, agent: null });

describe("project terminal list", () => {
  it("counts only the panes a thread shows, or every live terminal when it has none", () => {
    expect(countProjectTerminals(threads)).toBe(3);
  });

  it("lists rows flat, sorted by title within a thread, and derives each state", () => {
    const rows = projectTerminalRows({ threads, identify: byId, nowMs: NOW });
    expect(rows.map((row) => [row.terminalId, row.state])).toEqual([
      ["term-2", "busy"],
      ["term-10", "idle"],
      ["other", "closing"],
    ]);
    expect(rows[2]).toMatchObject({ closesInMinutes: 5, threadTitle: "Thread B" });
  });

  it("titles a terminal by its agent and keeps its location for the tooltip", () => {
    const rows = projectTerminalRows({
      threads,
      identify: (_threadId, terminalId) =>
        terminalId === "term-2"
          ? { title: "OpenCode", agent: "opencode" }
          : { title: "Terminal", agent: null },
      nowMs: NOW,
    });
    const agent = rows.find((row) => row.terminalId === "term-2")!;
    expect(agent).toMatchObject({ title: "OpenCode", agent: "opencode" });
    expect(projectTerminalDetailText(agent)).toBeNull();
    expect(projectTerminalStateLabel(agent.state)).toBe("Busy");
    expect(projectTerminalLocationText(agent)).toBe("Present · Thread A");
    expect(projectTerminalLocationText({ group: "", threadTitle: "" })).toBe("Untitled thread");
  });

  it("ignores a passed idle deadline and selects idle rows for Close idle", () => {
    const later = projectTerminalRows({ threads, identify: byId, nowMs: NOW + 10 * 60_000 });
    expect(later.find((row) => row.terminalId === "other")!.state).toBe("idle");
    const rows = projectTerminalRows({ threads, identify: byId, nowMs: NOW });
    expect(projectTerminalDetailText(rows[2]!)).toBe("Closes in 5 minutes");
    // A row about to be idle-closed is idle too, so Close idle includes it.
    expect(rows[2]!.state).toBe("closing");
    expect(idleProjectTerminals(rows).map((row) => row.terminalId)).toEqual(["term-10", "other"]);
  });
});

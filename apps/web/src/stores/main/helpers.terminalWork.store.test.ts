import { describe, expect, it } from "vitest";
import type { SidebarThreadSummary } from "../../models/types";
import type { AppState } from "./main.store";
import { applyTerminalWorkActivity, withTerminalWork } from "./helpers.terminalWork.store";

const finished = {
  terminalId: "a",
  finishedAt: "2026-01-02T00:00:00.000Z",
  exitCode: 1,
  durationMs: 61_000,
  source: "shell-integration" as const,
};
const summary = (overrides: Partial<SidebarThreadSummary> = {}) =>
  ({ id: "t", latestTerminalActivityAt: null, terminalFinished: [], ...overrides }) as never;
const state = (value: SidebarThreadSummary) =>
  ({ sidebarThreadsById: { t: value } }) as unknown as AppState;
const item = (overrides: Record<string, unknown>) => ({
  type: "workActivity" as const,
  threadId: "t",
  terminalId: "a",
  createdAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

describe("terminal work in sidebar summaries", () => {
  it("moves recency forward only", () => {
    const next = applyTerminalWorkActivity(
      state(summary({ latestTerminalActivityAt: "2026-01-03T00:00:00.000Z" })),
      item({ latestActivityAt: "2026-01-02T00:00:00.000Z" }),
    );
    expect(next.sidebarThreadsById.t!.latestTerminalActivityAt).toBe("2026-01-03T00:00:00.000Z");
    const moved = applyTerminalWorkActivity(
      state(summary()),
      item({ latestActivityAt: "2026-01-04T00:00:00.000Z" }),
    );
    expect(moved.sidebarThreadsById.t!.latestTerminalActivityAt).toBe("2026-01-04T00:00:00.000Z");
  });

  it("raises and clears one pane's finished item", () => {
    const raised = applyTerminalWorkActivity(state(summary()), item({ finished }));
    expect(raised.sidebarThreadsById.t!.terminalFinished).toEqual([finished]);
    const cleared = applyTerminalWorkActivity(raised, item({ finished: null }));
    expect(cleared.sidebarThreadsById.t!.terminalFinished).toEqual([]);
  });

  it("ignores unknown threads and keeps terminal fields when a summary is rebuilt", () => {
    const original = state(summary());
    expect(applyTerminalWorkActivity(original, item({ threadId: "x", finished }))).toBe(original);
    const previous = summary({
      latestTerminalActivityAt: "2026-01-05T00:00:00.000Z",
      terminalFinished: [finished],
    });
    const rebuilt = withTerminalWork({ id: "t" } as never, previous);
    expect(rebuilt.latestTerminalActivityAt).toBe("2026-01-05T00:00:00.000Z");
    expect(rebuilt.terminalFinished).toEqual([finished]);
  });
});

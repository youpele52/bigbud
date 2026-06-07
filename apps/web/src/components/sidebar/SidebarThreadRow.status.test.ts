import { describe, expect, it } from "vitest";

import { mergeRunningTerminalIds, terminalStatusFromRunningIds } from "./SidebarThreadRow.status";

describe("SidebarThreadRow.status", () => {
  it("deduplicates running terminal ids across drawer and panel terminals", () => {
    expect(
      mergeRunningTerminalIds(["default", "panel-terminal-1"], ["panel-terminal-1", ""]),
    ).toEqual(["default", "panel-terminal-1"]);
  });

  it("shows a running terminal indicator when either terminal surface is active", () => {
    expect(
      terminalStatusFromRunningIds(mergeRunningTerminalIds([], ["panel-terminal-1"])),
    ).toMatchObject({
      label: "Terminal process running",
      colorClass: "text-info-foreground",
      pulse: true,
    });
  });
});

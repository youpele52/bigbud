import { describe, expect, it } from "vitest";

import {
  mergeRunningTerminalIds,
  providerIconPresentationClass,
  shouldAnimateProviderIcon,
  shouldShowThreadConnectingPresentation,
  terminalStatusFromRunningIds,
} from "./SidebarThreadRow.status";

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

  it("keeps higher-priority resolved statuses visible during a raw connecting session", () => {
    expect(
      shouldShowThreadConnectingPresentation(
        {
          label: "Pending Approval",
          colorClass: "text-primary",
          dotClass: "bg-primary",
          pulse: false,
        },
        "2026-08-14T12:00:00.000Z",
      ),
    ).toBe(false);
  });

  it("maps stable provider icons to connecting, working, completed, and idle colors", () => {
    expect(
      providerIconPresentationClass({
        isCompleted: false,
        isCompacting: false,
        isConnecting: true,
        isError: false,
        isRunning: false,
      }),
    ).toBe("text-warning");
    expect(
      providerIconPresentationClass({
        isCompleted: false,
        isCompacting: false,
        isConnecting: false,
        isError: false,
        isRunning: true,
      }),
    ).toBe("text-info-foreground");
    expect(
      providerIconPresentationClass({
        isCompleted: true,
        isCompacting: false,
        isConnecting: false,
        isError: false,
        isRunning: false,
      }),
    ).toBe("text-success");
    expect(
      providerIconPresentationClass({
        isCompleted: false,
        isCompacting: false,
        isConnecting: false,
        isError: false,
        isRunning: false,
      }),
    ).toBe("text-muted-foreground");
    expect(
      providerIconPresentationClass({
        isCompleted: false,
        isCompacting: false,
        isConnecting: false,
        isError: true,
        isRunning: false,
      }),
    ).toBe("text-destructive");
    expect(
      providerIconPresentationClass({
        isCompleted: false,
        isCompacting: false,
        isConnecting: false,
        isError: false,
        isRunning: true,
      }),
    ).toBe("text-info-foreground");
    expect(
      providerIconPresentationClass({
        isCompleted: false,
        isCompacting: true,
        isConnecting: false,
        isError: false,
        isRunning: true,
      }),
    ).toBe("text-warning");
    expect(shouldAnimateProviderIcon({ isConnecting: true, isRunning: false })).toBe(true);
    expect(shouldAnimateProviderIcon({ isConnecting: false, isRunning: false })).toBe(false);
  });
});

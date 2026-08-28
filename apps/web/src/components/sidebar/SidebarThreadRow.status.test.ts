import { describe, expect, it } from "vitest";

import {
  mergeRunningTerminalIds,
  providerIconPresentationClass,
  shouldAnimateProviderIcon,
  shouldShowThreadConnectingPresentation,
  shouldShowThreadStatusLabel,
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

  it("uses only the muted provider icon for idle threads", () => {
    expect(
      shouldShowThreadStatusLabel({
        label: "Idle",
        colorClass: "text-muted-foreground",
        dotClass: "bg-muted-foreground",
        pulse: false,
      }),
    ).toBe(false);
    expect(
      shouldShowThreadStatusLabel({
        label: "Connection Warning",
        colorClass: "text-warning",
        dotClass: "bg-warning",
        pulse: false,
      }),
    ).toBe(true);
  });

  it("uses only the red provider icon for failed threads", () => {
    const failedStatus = {
      label: "Failed" as const,
      colorClass: "text-destructive",
      dotClass: "bg-destructive",
      pulse: false,
    };

    expect(providerIconPresentationClass(failedStatus)).toBe("text-destructive");
    expect(shouldShowThreadStatusLabel(failedStatus)).toBe(false);
  });

  it("passes resolved state colors through to stable provider icons", () => {
    const iconClass = (label: "Connection Warning" | "Working" | "Pending Approval") =>
      providerIconPresentationClass({
        label,
        colorClass:
          label === "Connection Warning"
            ? "text-warning"
            : label === "Working"
              ? "text-info-foreground"
              : "text-primary",
        dotClass: "bg-primary",
        pulse: false,
      });

    expect(iconClass("Connection Warning")).toBe("text-warning");
    expect(iconClass("Working")).toBe("text-info-foreground");
    expect(iconClass("Pending Approval")).toBe("text-primary");
    expect(
      providerIconPresentationClass({
        label: "Done",
        colorClass: "text-primary",
        dotClass: "bg-primary",
        pulse: false,
      }),
    ).toBe("text-success");
    expect(providerIconPresentationClass(null)).toBe("text-muted-foreground");
    expect(shouldAnimateProviderIcon({ isConnecting: true, isRunning: false })).toBe(true);
    expect(shouldAnimateProviderIcon({ isConnecting: false, isRunning: false })).toBe(false);
  });
});

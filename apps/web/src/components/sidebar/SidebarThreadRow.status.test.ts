import { describe, expect, it } from "vitest";
import { resolveThreadStatusPill } from "./Sidebar.logic.status";

import {
  isProviderIconWorking,
  mergeRunningTerminalIds,
  providerIconPresentationClass,
  shouldAnimateProviderIcon,
  shouldShowThreadConnectingPresentation,
  shouldShowThreadStatusLabel,
  hasPendingIdleWarning,
  livenessForThreadPanes,
  terminalStatusFromFinished,
  terminalStatusFromLiveness,
} from "./SidebarThreadRow.status";

const finishedItem = (exitCode: number | null, finishedAt: string) =>
  ({
    paneId: "p",
    command: "sleep 70; false",
    exitCode,
    finishedAt,
    source: "shell-integration",
  }) as never;

describe("SidebarThreadRow.status", () => {
  it("uses a steady amber provider icon while awaiting an answer", () => {
    const status = resolveThreadStatusPill({
      thread: {
        hasPendingUserInput: true,
        hasPendingApprovals: false,
        hasActionableProposedPlan: false,
        interactionMode: "default",
        latestTurn: null,
        providerAgents: [],
        session: null,
      },
    });
    expect(status?.label).toBe("Awaiting Input");
    expect(providerIconPresentationClass(status, false)).toBe("text-warning");
    expect(isProviderIconWorking(status)).toBe(false);
  });
  it("deduplicates running terminal ids across drawer and panel terminals", () => {
    expect(
      mergeRunningTerminalIds(["default", "panel-terminal-1"], ["panel-terminal-1", ""]),
    ).toEqual(["default", "panel-terminal-1"]);
  });

  it("shows live terminals muted, blue with a pulse when busy, and amber with a pending warning", () => {
    const now = Date.parse("2026-11-21T10:00:00.000Z");
    const quiet = { busy: false, idleClosesAt: null };
    expect(terminalStatusFromLiveness({}, now)).toBeNull();
    expect(terminalStatusFromLiveness({ a: quiet }, now)).toEqual({
      label: "1 terminal running",
      colorClass: "text-muted-foreground",
      pulse: false,
    });
    expect(terminalStatusFromLiveness({ a: { ...quiet, busy: true } }, now)).toMatchObject({
      label: "1 terminal running (busy)",
      colorClass: "text-info-foreground",
      pulse: true,
    });
    expect(
      terminalStatusFromLiveness({ a: { ...quiet, busy: true }, b: quiet, c: quiet }, now),
    ).toMatchObject({ label: "3 terminals running (1 busy)", pulse: true });
    const warned = {
      a: { ...quiet, busy: true },
      b: { busy: false, idleClosesAt: "2026-11-21T10:00:50.000Z" },
    };
    expect(hasPendingIdleWarning(warned, now)).toBe(true);
    expect(terminalStatusFromLiveness(warned, now)).toEqual({
      label: "Terminal closes in 1 minute (idle)",
      colorClass: "text-warning",
      pulse: false,
    });
    expect(
      terminalStatusFromLiveness(
        { b: { busy: false, idleClosesAt: "2026-11-21T10:02:30.000Z" } },
        now,
      )?.label,
    ).toBe("Terminal closes in 3 minutes (idle)");
    // A passed deadline is stale: the close notice or the next inventory removes the terminal.
    const stale = { b: { busy: false, idleClosesAt: "2026-11-21T09:59:00.000Z" } };
    expect(hasPendingIdleWarning(stale, now)).toBe(false);
    expect(terminalStatusFromLiveness(stale, now)?.label).toBe("1 terminal running");
  });

  it("counts only the thread's panes when it has any, and every live terminal otherwise", () => {
    const quiet = { busy: false, idleClosesAt: null };
    const liveness = { a: quiet, b: { ...quiet, busy: true } };
    expect(livenessForThreadPanes(liveness, [])).toBe(liveness);
    expect(livenessForThreadPanes(liveness, ["a", "b", "c"])).toBe(liveness);
    expect(livenessForThreadPanes(liveness, ["b"])).toEqual({ b: { ...quiet, busy: true } });
    expect(livenessForThreadPanes(liveness, ["z"])).toEqual({});
  });

  it("shows finished terminal work as a red icon on failure and green otherwise, without the exit code", () => {
    const failed = terminalStatusFromFinished([finishedItem(1, "2026-01-01T10:00:00.000Z")]);
    expect(failed).toEqual({
      label: "Terminal command failed: sleep 70; false",
      colorClass: "text-destructive",
      pulse: false,
    });
    expect(failed?.label).not.toContain("exit");
    expect(
      terminalStatusFromFinished([
        finishedItem(1, "2026-01-01T10:00:00.000Z"),
        finishedItem(0, "2026-01-01T11:00:00.000Z"),
      ]),
    ).toMatchObject({ colorClass: "text-success" });
    expect(terminalStatusFromFinished([])).toBeNull();
    expect(terminalStatusFromFinished(undefined)).toBeNull();
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

    expect(providerIconPresentationClass(failedStatus, false)).toBe("text-destructive");
    expect(shouldShowThreadStatusLabel(failedStatus)).toBe(false);
  });

  it("passes resolved state colors through to stable provider icons", () => {
    const iconClass = (label: "Connection Warning" | "Working" | "Pending Approval") =>
      providerIconPresentationClass(
        {
          label,
          colorClass:
            label === "Connection Warning"
              ? "text-warning"
              : label === "Working"
                ? "text-info-foreground"
                : "text-primary",
          dotClass: "bg-primary",
          pulse: false,
        },
        false,
      );

    expect(iconClass("Connection Warning")).toBe("text-warning");
    expect(iconClass("Working")).toBe("text-info-foreground");
    expect(iconClass("Pending Approval")).toBe("text-primary");
    expect(
      providerIconPresentationClass(
        {
          label: "Done",
          colorClass: "text-primary",
          dotClass: "bg-primary",
          pulse: false,
        },
        false,
      ),
    ).toBe("text-success");
    expect(providerIconPresentationClass(null, false)).toBe("text-muted-foreground");
    expect(shouldAnimateProviderIcon({ isConnecting: true, isRunning: false })).toBe(true);
    expect(shouldAnimateProviderIcon({ isConnecting: false, isRunning: false })).toBe(false);
  });

  it("breathes for main or child work while preserving the resolved icon color", () => {
    expect(isProviderIconWorking({ label: "Working" } as never)).toBe(true);
    expect(isProviderIconWorking({ label: "Subagents Working" } as never)).toBe(true);
    expect(isProviderIconWorking({ label: "Idle" } as never)).toBe(false);
    const childStatus = {
      label: "Subagents Working",
      colorClass: "text-info-foreground",
      dotClass: "bg-info-foreground",
      pulse: true,
    } as never;
    expect(providerIconPresentationClass(childStatus, false)).toBe("text-violet-500");
    expect(shouldShowThreadStatusLabel(childStatus)).toBe(false);
    expect(
      shouldAnimateProviderIcon({
        isConnecting: false,
        isRunning: isProviderIconWorking(childStatus),
      }),
    ).toBe(true);
  });

  it("uses the warning color for the provider icon during connecting", () => {
    expect(
      providerIconPresentationClass(
        {
          label: "Getting Ready",
          colorClass: "text-info-foreground",
          dotClass: "bg-info-foreground",
          pulse: true,
        },
        true,
      ),
    ).toBe("text-warning");
  });
});

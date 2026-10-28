import type {
  ComputerUseActivitySnapshot,
  ComputerUseStopResult,
} from "@bigbud/contracts/server/computerUseActivity.ts";

/**
 * Severity follows the toast convention (blue in progress, green done, amber warning, red
 * failure); OS notifications carry it in the title.
 */
export interface MascotComputerUseStopFeedback {
  readonly severity: "progress" | "success" | "warning" | "error";
  readonly title: string;
  readonly body: string;
}

export interface MascotComputerUseStopDeps {
  readonly subscribeActivity: (
    listener: (snapshot: ComputerUseActivitySnapshot) => void,
  ) => () => void;
  readonly stop: () => Promise<ComputerUseStopResult>;
  /** Tells Electron main whether the mascot menu offers "Stop computer use". */
  readonly setActive: (active: boolean) => Promise<unknown>;
  readonly onStopRequested: (listener: () => void) => () => void;
  readonly notify: (feedback: MascotComputerUseStopFeedback) => void;
}

export interface MascotComputerUseStopBridge {
  /** A disconnected server can neither report activity nor stop it, so the item hides. */
  readonly setConnected: (connected: boolean) => void;
  /** Hides the menu item and stops listening. */
  readonly dispose: () => void;
}

export const COMPUTER_USE_STOPPING_FEEDBACK: MascotComputerUseStopFeedback = {
  severity: "progress",
  title: "Stopping computer use…",
  body: "Interrupting agents and resetting the desktop driver.",
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function describeComputerUseStopResult(
  result: ComputerUseStopResult,
): MascotComputerUseStopFeedback {
  if (!result.active) {
    return {
      severity: "success",
      title: "Computer use already stopped",
      body: "No agent was using computer use any more.",
    };
  }
  const count = result.interruptedThreadIds.length;
  const stopped =
    count > 0
      ? `Interrupt requested for ${plural(count, "agent turn")}.`
      : "No agent turn was still running.";
  const warnings = [
    ...(result.failedThreadIds.length > 0
      ? [`${plural(result.failedThreadIds.length, "turn")} could not be interrupted.`]
      : []),
    ...(result.driverReset === "failed"
      ? [`The desktop driver did not reset: ${result.driverResetError ?? "unknown error"}`]
      : []),
  ];
  if (warnings.length > 0) {
    return {
      severity: "warning",
      title: "Computer use stopped with warnings",
      body: [stopped, ...warnings].join(" "),
    };
  }
  const driver =
    result.driverReset === "reset"
      ? " The desktop driver was reset."
      : result.driverReset === "unavailable"
        ? " No desktop driver was running."
        : "";
  return { severity: "success", title: "Computer use stopped", body: `${stopped}${driver}` };
}

export function describeComputerUseStopFailure(error: unknown): MascotComputerUseStopFeedback {
  const detail =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "The bigbud server did not respond.";
  return { severity: "error", title: "Couldn't stop computer use", body: detail };
}

/**
 * Mirrors the server's computer-use activity into the mascot menu and runs a server Stop for
 * every press: each press takes a fresh server snapshot, so a turn that started meanwhile is
 * stopped too. A burst of presses shows one "Stopping…" notice and no redundant "already
 * stopped" result.
 */
export function startMascotComputerUseStopBridge(
  deps: MascotComputerUseStopDeps,
): MascotComputerUseStopBridge {
  let pushed: boolean | null = null;
  let active = false;
  let connected = true;
  let pending = 0;
  let burstStoppedSomething = false;
  const sync = () => {
    const next = connected && active;
    if (next === pushed) return;
    pushed = next;
    void deps.setActive(next).catch(() => undefined);
  };
  const unsubscribe = deps.subscribeActivity((snapshot) => {
    active = snapshot.active;
    sync();
  });
  const offStop = deps.onStopRequested(() => {
    if (pending === 0) {
      burstStoppedSomething = false;
      deps.notify(COMPUTER_USE_STOPPING_FEEDBACK);
    }
    pending += 1;
    void deps
      .stop()
      .then(
        (result) => {
          if (result.active) burstStoppedSomething = true;
          else if (burstStoppedSomething) return;
          deps.notify(describeComputerUseStopResult(result));
        },
        (error: unknown) => deps.notify(describeComputerUseStopFailure(error)),
      )
      .finally(() => {
        pending -= 1;
      });
  });
  return {
    setConnected: (next) => {
      connected = next;
      sync();
    },
    dispose: () => {
      offStop();
      unsubscribe();
      active = false;
      sync();
    },
  };
}

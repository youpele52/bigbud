import type { DesktopQuitReason } from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import type { App, BrowserWindow, PowerMonitor } from "electron";

import type { BackendQuitHint } from "./backend/backendLifecycleHintPipe";
import type { AppQuitActions } from "./main.appQuitActions";

/** How long Electron main waits for the server's quit ack before quitting anyway. */
export const QUIT_HINT_ACK_TIMEOUT_MS = 1_500;

/**
 * - `idle`: no quit has started; the first `before-quit` is prevented and starts the handshake.
 * - `pending`: the quit hint is written and its ack awaited; further quit requests are ignored.
 * - `done`: the next `before-quit` runs the teardown and lets the quit proceed.
 */
export type QuitHandshakeState = "idle" | "pending" | "done";

interface PreventableEvent {
  preventDefault(): void;
}

export interface DesktopQuitTeardownDeps {
  readonly appInstance: Pick<App, "quit">;
  readonly log: (message: string) => void;
  /** Sets main's `isQuitting` before any teardown step runs. */
  readonly markQuitting: () => void;
  /** Stops the backend and every main-process service; runs once per app lifetime. */
  readonly stopRuntime: () => void;
  /** Writes the quit line on fd 5; null when no backend can hear it. */
  readonly sendQuitHint: (reason: DesktopQuitReason) => BackendQuitHint | null;
  readonly ackTimeoutMs?: number;
}

export interface DesktopQuitTeardown {
  readonly getHandshakeState: () => QuitHandshakeState;
  /** Shared idempotent teardown, called from `before-quit` and `before-quit-for-update`. */
  readonly prepareForAppQuit: (reason: string) => void;
  /** The reason the next handshake announces; Restart sets `restart`. */
  readonly setQuitReason: (reason: DesktopQuitReason) => void;
  readonly handleBeforeQuit: (event: PreventableEvent) => void;
  /** The update path: announce, wait for the ack, and mark the handshake done (F7). */
  readonly runHandshake: (reason: DesktopQuitReason) => Promise<void>;
  /** For quits whose backend is already gone or must not be told: no hint, no wait. */
  readonly skipHandshake: (why: string) => void;
  /** OS shutdown or logout: tear down now and quit, with no hint and no wait. */
  readonly quitForSessionEnd: (source: string) => void;
}

/**
 * The acknowledged quit handshake (plan §14, N10). Electron's `before-quit` is synchronous,
 * so the first one is prevented while main announces quit intent and waits up to 1,500 ms for
 * the server's ack; then main calls `app.quit()` once more and the re-entrant `before-quit`
 * runs the teardown. The server only learns the intent: whether terminals close is its policy.
 */
export function createDesktopQuitTeardown(deps: DesktopQuitTeardownDeps): DesktopQuitTeardown {
  const ackTimeoutMs = deps.ackTimeoutMs ?? QUIT_HINT_ACK_TIMEOUT_MS;
  let state: QuitHandshakeState = "idle";
  let quitReason: DesktopQuitReason = "quit";
  let teardownComplete = false;
  let pendingHandshake: Promise<void> | null = null;
  let reentrantQuitIssued = false;

  const prepareForAppQuit = (reason: string) => {
    if (teardownComplete) return;
    teardownComplete = true;
    state = "done";
    deps.markQuitting();
    deps.log(`${reason} received`);
    deps.stopRuntime();
  };

  /** Writes the hint and resolves after the ack or the deadline; null when nothing listens. */
  const startHandshake = (reason: DesktopQuitReason): Promise<void> | null => {
    const hint = deps.sendQuitHint(reason);
    if (hint === null) {
      deps.log(`quit handshake skipped reason=${reason} cause=no-backend-pipe`);
      state = "done";
      return null;
    }
    state = "pending";
    const startedAt = Date.now();
    deps.log(`quit handshake started reason=${reason} sequence=${hint.sequence}`);
    pendingHandshake = hint.acknowledged(ackTimeoutMs).then(
      (acked) => {
        deps.log(
          `quit handshake ${acked ? "acked" : "timed out"} sequence=${hint.sequence} elapsedMs=${Date.now() - startedAt}`,
        );
        state = "done";
      },
      () => {
        state = "done";
      },
    );
    return pendingHandshake;
  };

  return {
    getHandshakeState: () => state,
    prepareForAppQuit,
    setQuitReason: (reason) => {
      quitReason = reason;
    },
    handleBeforeQuit: (event) => {
      if (state === "done" || teardownComplete) {
        prepareForAppQuit("before-quit");
        return;
      }
      if (state === "pending") {
        event.preventDefault();
        deps.log("quit request ignored while the quit handshake is pending");
        return;
      }
      const handshake = startHandshake(quitReason);
      if (handshake === null) {
        prepareForAppQuit("before-quit");
        return;
      }
      event.preventDefault();
      void handshake.then(() => {
        if (reentrantQuitIssued) return;
        reentrantQuitIssued = true;
        deps.appInstance.quit();
      });
    },
    runHandshake: async (reason) => {
      if (state === "done" || teardownComplete) return;
      const handshake = state === "pending" ? pendingHandshake : startHandshake(reason);
      if (handshake) await handshake;
      state = "done";
    },
    skipHandshake: (why) => {
      if (state !== "done") deps.log(`quit handshake skipped cause=${why}`);
      state = "done";
    },
    quitForSessionEnd: (source) => {
      deps.log(`os session ending source=${source}; quitting without a quit hint`);
      // Also covers a handshake already pending: the session will not wait for its ack.
      state = "done";
      reentrantQuitIssued = true;
      prepareForAppQuit(source);
      deps.appInstance.quit();
    },
  };
}

/** Restart announces `restart`; the other actions keep the default `quit` reason. */
export function withQuitIntentReason(
  actions: AppQuitActions,
  teardown: Pick<DesktopQuitTeardown, "setQuitReason">,
): AppQuitActions {
  return {
    ...actions,
    restart: (reason) => {
      teardown.setQuitReason("restart");
      actions.restart(reason);
    },
  };
}

type QuitTeardownApp = {
  on(event: "before-quit", listener: (event: PreventableEvent) => void): unknown;
  on(
    event: "browser-window-created",
    listener: (event: unknown, window: Pick<BrowserWindow, "on">) => void,
  ): unknown;
};

/** `before-quit`, plus Windows' per-window `session-end` (shutdown, restart or log-off). */
export function registerQuitTeardownAppHandlers(
  appInstance: QuitTeardownApp,
  teardown: DesktopQuitTeardown,
  platform: NodeJS.Platform = process.platform,
): void {
  appInstance.on("before-quit", (event) => teardown.handleBeforeQuit(event));
  if (platform !== "win32") return;
  appInstance.on("browser-window-created", (_event, window) => {
    window.on("session-end", () => teardown.quitForSessionEnd("session-end"));
  });
}

/** macOS and Linux OS shutdown or logout. `powerMonitor` is usable only after `ready`. */
export function registerQuitTeardownPowerMonitor(
  monitor: Pick<PowerMonitor, "on">,
  teardown: DesktopQuitTeardown,
): void {
  monitor.on("shutdown", () => teardown.quitForSessionEnd("shutdown"));
}

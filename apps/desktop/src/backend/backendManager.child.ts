import type { ChildProcess } from "node:child_process";

import {
  getBackendStartupState,
  recordBackendStartupDevelopmentDiagnostics,
  recordBackendStartupFailure,
} from "./backendStartupState";
import {
  createBackendStartupDiagnostics,
  createDevelopmentBackendDiagnostics,
} from "./backendStartupDiagnostics";

interface BackendChildLifecycleOptions {
  readonly generation: number;
  readonly isDevelopmentDiagnostics: boolean;
  readonly getIsQuitting: () => boolean;
  readonly getStderrTail: () => string;
  readonly isExpectedExit: () => boolean;
  readonly onDisconnected: () => void;
  readonly closeSession: (details: string) => void;
  readonly logLifecycle: (event: string, details: string) => void;
  readonly scheduleRestart: (reason: string) => void;
}

/** Waits for child streams to close before deciding whether a startup failure is retryable. */
export function attachBackendChildLifecycle(
  child: ChildProcess,
  options: BackendChildLifecycleOptions,
): void {
  const { generation, logLifecycle, closeSession } = options;
  const restartUnlessBlocked = (reason: string) => {
    if (options.getIsQuitting() || options.isExpectedExit()) return;
    const state = getBackendStartupState();
    if (
      state.generation === generation &&
      (state.failureReason === "state_directory_in_use" ||
        state.failureReason === "state_directory_owner_unverified")
    ) {
      logLifecycle("restart_blocked", `generation=${generation} reason=${state.failureReason}`);
      return;
    }
    options.scheduleRestart(reason);
  };

  child.on("error", (error) => {
    options.onDisconnected();
    const stderrTail = options.getStderrTail();
    logLifecycle(
      "child_error",
      `generation=${generation} pid=${child.pid ?? "unknown"} error=${error.stack ?? error.message} stderr=${stderrTail}`,
    );
    const developmentDiagnostics = options.isDevelopmentDiagnostics
      ? createDevelopmentBackendDiagnostics({ error, stderrTail })
      : undefined;
    recordBackendStartupFailure(
      generation,
      "child_spawn_failed",
      createBackendStartupDiagnostics({
        category: "process",
        errorMessage: error.message,
        stderrTail,
      }),
      developmentDiagnostics,
    );
    if (developmentDiagnostics)
      recordBackendStartupDevelopmentDiagnostics(generation, developmentDiagnostics);
    closeSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    restartUnlessBlocked(error.message);
  });

  // `exit` can precede fd4/stderr draining. `close` preserves a late typed ownership failure
  // before retry policy runs, rather than overwriting it with a generic child-exit failure.
  child.on("close", (code, signal) => {
    options.onDisconnected();
    const stderrTail = options.getStderrTail();
    logLifecycle(
      "child_exit",
      `generation=${generation} pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderrTail}`,
    );
    const developmentDiagnostics = options.isDevelopmentDiagnostics
      ? createDevelopmentBackendDiagnostics({ exitCode: code, exitSignal: signal, stderrTail })
      : undefined;
    recordBackendStartupFailure(
      generation,
      "child_exit_before_ready",
      createBackendStartupDiagnostics({
        category: "process",
        exitCode: code,
        exitSignal: signal,
        stderrTail,
      }),
      developmentDiagnostics,
    );
    if (developmentDiagnostics)
      recordBackendStartupDevelopmentDiagnostics(generation, developmentDiagnostics);
    closeSession(`pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`);
    const detail = stderrTail.trim().slice(-512).replace(/\n/g, " ↵ ");
    restartUnlessBlocked(
      `code=${code ?? "null"} signal=${signal ?? "null"}${detail ? ` stderr=${detail}` : ""}`,
    );
  });
}

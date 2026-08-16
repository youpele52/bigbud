import { BrowserWindow } from "electron";
import type {
  DesktopBackendStartupDiagnostics,
  DesktopBackendDevelopmentDiagnostics,
  DesktopBackendStartupFailureReason,
  DesktopBackendStartupState,
} from "@bigbud/contracts/server/ipc.desktop.ts";
import { createBackendStartupDiagnostics } from "./backendStartupDiagnostics";

const STARTUP_DEADLINE_MS = 10 * 60 * 1_000;
let state: DesktopBackendStartupState = { generation: 0, startedAt: 0, status: "idle" };
let timer: ReturnType<typeof setTimeout> | null = null;
let channel = "";
let allowDevelopmentDiagnostics = false;

export function configureBackendStartupState(
  stateChannel: string,
  allowDevelopment: boolean,
): void {
  channel = stateChannel;
  allowDevelopmentDiagnostics = allowDevelopment;
}

export function getBackendStartupState(): DesktopBackendStartupState {
  return allowDevelopmentDiagnostics ? state : { ...state, developmentDiagnostics: undefined };
}

function emit(): void {
  const publicState = allowDevelopmentDiagnostics
    ? state
    : { ...state, developmentDiagnostics: undefined };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, publicState);
  }
}

function setStatus(
  generation: number,
  status: DesktopBackendStartupState["status"],
  failure?: {
    readonly diagnostics?: DesktopBackendStartupDiagnostics | undefined;
    readonly developmentDiagnostics?: DesktopBackendDevelopmentDiagnostics | undefined;
    readonly reason: DesktopBackendStartupFailureReason;
  },
): boolean {
  if (!canTransition(generation, status)) return false;
  state = {
    ...state,
    status,
    ...(status === "ready"
      ? { developmentDiagnostics: undefined, diagnostics: undefined, failureReason: undefined }
      : {}),
    ...(failure && !state.failureReason
      ? {
          developmentDiagnostics: failure.developmentDiagnostics,
          diagnostics: failure.diagnostics,
          failureReason: failure.reason,
        }
      : {}),
  };
  emit();
  return true;
}

function canTransition(generation: number, next: DesktopBackendStartupState["status"]): boolean {
  if (state.generation !== generation || state.status === next) return false;
  if (state.status === "timedOut") return next === "ready";
  if (state.status === "failed" || state.status === "ready") return false;
  return true;
}

function clearDeadline(generation: number): void {
  if (state.generation !== generation || !timer) return;
  clearTimeout(timer);
  timer = null;
}

export function beginBackendStartup(startedAt = Date.now()): number {
  if (timer) clearTimeout(timer);
  timer = null;
  const generation = state.generation + 1;
  state = { generation, startedAt, status: "starting" };
  emit();
  timer = setTimeout(() => {
    timer = null;
    setStatus(generation, "timedOut", {
      diagnostics: createBackendStartupDiagnostics({ category: "timeout" }),
      reason: "startup_timed_out",
    });
  }, STARTUP_DEADLINE_MS);
  timer.unref();
  return generation;
}

export function recordBackendStartupStatus(
  generation: number,
  value: unknown,
  reason?: DesktopBackendStartupFailureReason,
): boolean {
  if (value === "upgrading" || value === "starting" || value === "ready") {
    const accepted = setStatus(generation, value);
    if (accepted && value === "ready") clearDeadline(generation);
    return accepted;
  } else if (value === "error") {
    const accepted = setStatus(generation, "failed", {
      diagnostics: createBackendStartupDiagnostics({ category: "runtime" }),
      reason: reason ?? "unknown",
    });
    if (accepted) clearDeadline(generation);
    return accepted;
  }
  return false;
}

export function recordBackendStartupFailure(
  generation: number,
  reason: DesktopBackendStartupFailureReason = "unknown",
  diagnostics?: DesktopBackendStartupDiagnostics,
  developmentDiagnostics?: DesktopBackendDevelopmentDiagnostics,
): void {
  clearDeadline(generation);
  setStatus(generation, "failed", { developmentDiagnostics, diagnostics, reason });
}

/** Updates development crash context when child streams flush after the initial failure. */
export function recordBackendStartupDevelopmentDiagnostics(
  generation: number,
  diagnostics: DesktopBackendDevelopmentDiagnostics,
): void {
  if (
    !allowDevelopmentDiagnostics ||
    state.generation !== generation ||
    (state.status !== "failed" && state.status !== "timedOut")
  ) {
    return;
  }
  state = { ...state, developmentDiagnostics: diagnostics };
  emit();
}

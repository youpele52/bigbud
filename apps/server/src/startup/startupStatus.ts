import * as FS from "node:fs";
import type { DesktopBackendStartupFailureReason } from "@bigbud/contracts/server/ipc.desktop.ts";

export type StartupStatus = "upgrading" | "starting" | "ready" | "error";
type ServerStartupFailureReason = Extract<
  DesktopBackendStartupFailureReason,
  | "bootstrap_failed"
  | "state_directory_in_use"
  | "state_directory_owner_unverified"
  | "projection_database_initialization_failed"
  | "server_runtime_startup_failed"
  | "unknown"
>;

/** Logs only every this many percent, so progress stays readable in development logs. */
const STARTUP_PROGRESS_LOG_STEP = 10;

function writeStartupRecord(record: Record<string, unknown>): void {
  const startupStatusFd = Number(process.env.BIGBUD_STARTUP_STATUS_FD);
  if (!Number.isInteger(startupStatusFd) || startupStatusFd < 0) return;
  try {
    FS.writeSync(startupStatusFd, `${JSON.stringify(record)}\n`);
  } catch {
    // The Electron parent owns pipe failures; startup must not fail because it detached.
  }
}

/** Reports `upgrading` with an integer percent of local data migration work done. */
export function writeStartupProgress(percent: number): void {
  const progress = Math.max(0, Math.min(100, Math.floor(percent)));
  if (progress % STARTUP_PROGRESS_LOG_STEP === 0) {
    console.info(`[startup] status=upgrading progress=${progress}%`);
  }
  writeStartupRecord({ progress, status: "upgrading" });
}

export function writeStartupStatus(status: Exclude<StartupStatus, "error">): void;
export function writeStartupStatus(status: "error", reason?: ServerStartupFailureReason): void;
export function writeStartupStatus(
  status: StartupStatus,
  reason?: ServerStartupFailureReason,
): void {
  // Keep readiness visible in development logs as well as the desktop-only pipe.
  console.info(
    `[startup] status=${status}${status === "error" ? ` reason=${reason ?? "unknown"}` : ""}`,
  );
  writeStartupRecord(status === "error" ? { reason: reason ?? "unknown", status } : { status });
}

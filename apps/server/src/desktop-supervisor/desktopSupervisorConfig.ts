import { existsSync } from "node:fs";

export const DESKTOP_SUPERVISOR_RESTART_ATTEMPTS = 3;
export const DESKTOP_SUPERVISOR_RESTART_WINDOW_MS = 15_000;
export const DESKTOP_SUPERVISOR_HEARTBEAT_MS = 5_000;
export const DESKTOP_SUPERVISOR_INPUT_CAPACITY = 2_000;
export const DESKTOP_SUPERVISOR_OUTPUT_CAPACITY = 32;
export const DESKTOP_SUPERVISOR_REPLAY_BUFFER_CAPACITY = 4_000;
export const DESKTOP_SUPERVISOR_APPLICATION_ACK_TIMEOUT_MS = 15_000;
export const DESKTOP_SUPERVISOR_BASELINE_ACK_TIMEOUT_MS = 65_000;
// Detached generation fences use logical LRU eviction at this hard capacity.
// They intentionally have no wall-clock TTL, so behavior is independent of clock changes.
export const DESKTOP_SUPERVISOR_DETACHED_GENERATION_TOMBSTONE_CAPACITY = 1_024;
export const DESKTOP_SUPERVISOR_ACTIVE_SESSION_LIMIT = 32;

export type DesktopSupervisorRuntimeConfig =
  | { readonly mode: "direct-unmanaged"; readonly reasonCode: "standalone" | "disabled" }
  | {
      readonly mode: "fallback-fenced";
      readonly reasonCode: "binary_missing" | "binary_invalid";
    }
  | { readonly mode: "supervisor"; readonly binaryPath: string };

export function resolveDesktopSupervisorRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): DesktopSupervisorRuntimeConfig {
  const packaged = environment.BIGBUD_DESKTOP_PACKAGED === "1";
  const gate = environment.BIGBUD_DESKTOP_SUPERVISOR_ENABLED?.trim();
  if (gate === "0") {
    return { mode: "direct-unmanaged", reasonCode: "disabled" };
  }
  if (!packaged && gate !== "1") {
    return { mode: "direct-unmanaged", reasonCode: "standalone" };
  }
  const binaryPath = environment.BIGBUD_DESKTOP_SUPERVISOR_BINARY?.trim();
  if (!binaryPath) return { mode: "fallback-fenced", reasonCode: "binary_missing" };
  if (!fileExists(binaryPath)) {
    return { mode: "fallback-fenced", reasonCode: "binary_invalid" };
  }
  return { mode: "supervisor", binaryPath };
}

export function desktopSupervisorRestartDelayMs(attempt: number): number {
  const base = Math.min(100 * 2 ** Math.max(0, attempt - 1), 1_000);
  const jitter = (attempt * 37) % 53;
  return base + jitter;
}

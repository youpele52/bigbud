import * as Cause from "effect/Cause";
import { hasLocalSupervisorServiceControls } from "../remote-backend/localSupervisorService.paths.ts";
import {
  describePrivatePermission,
  PrivatePermissionError,
} from "../remote-backend/privatePermission.ts";

/** The CLI action names users type; `disable-boot` dispatches the native `disable`. */
export type BackendCliAction = "setup" | "status" | "enable" | "disable-boot" | "start" | "stop";

const MAX_DEPTH = 8;
const MAX_REASONS = 3;
const MAX_REASON_LENGTH = 300;
const NATIVE_FAILURE = /^Local supervisor command failed \(code=\d+\)\./;

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && chain.length < MAX_DEPTH; ) {
    chain.push(current);
    current =
      current !== null && typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return chain;
}

/** Only the native launcher's own `Caused by:` lines: static refusals and OS error kinds. */
function nativeReasons(message: string): string[] {
  const marker = message.indexOf("Caused by:");
  if (marker < 0) return [];
  return message
    .slice(marker + "Caused by:".length)
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+:\s*)?/, "").trim())
    .filter((line) => line.length > 0 && !hasLocalSupervisorServiceControls(line))
    .slice(0, MAX_REASONS)
    .map((line) => line.slice(0, MAX_REASON_LENGTH));
}

function stateDirectoryInUse(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { _tag?: unknown })._tag === "StateDirLockError" &&
    (error as { reason?: unknown }).reason === "state_directory_in_use"
  );
}

const IN_USE: Partial<Record<BackendCliAction, string>> = {
  start: "Another backend process holds this backend's state directory; nothing was started.",
  enable:
    "Enable first runs a finite preflight that needs exclusive use of the backend state directory, so it cannot run while the backend is running. Run `bigbud backend stop`, then `bigbud backend enable --confirm-startup`, which preflights and starts the backend itself.",
  setup: "A backend process holds this state directory; setup was not attempted.",
};

/** A specific, non-secret reason for a failed backend command, or undefined for the generic text.
 * Our own error messages stay private: they can carry account paths. The one exception is a
 * permission refusal, which names the user's own path so they can fix its mode. */
export function describeBackendFailure(
  cause: Cause.Cause<unknown>,
  action: BackendCliAction,
): string | undefined {
  const chain = causes(Cause.squash(cause));
  if (chain.some(stateDirectoryInUse))
    return IN_USE[action] ?? "The backend is running and holds its state directory.";
  // A path that is not private enough: name it, the required mode and the chmod that fixes it.
  const permission = chain.find((error) => error instanceof PrivatePermissionError);
  if (permission) return describePrivatePermission(permission.detail);
  for (const error of chain) {
    const message = error instanceof Error ? error.message : undefined;
    if (!message || !NATIVE_FAILURE.test(message)) continue;
    const reasons = nativeReasons(message);
    if (reasons.length > 0) return `Native launcher refused: ${reasons.join("; ")}`;
  }
  return undefined;
}

/** Native `status` prints `<unit>: <State>; crash-restarts=<n>` for each account unit. */
export function backendUnitRunning(statusOutput: string, authorityId: string): boolean {
  return statusOutput
    .split("\n")
    .some((line) => line.startsWith(`bigbud-backend-${authorityId}.service: Active;`));
}

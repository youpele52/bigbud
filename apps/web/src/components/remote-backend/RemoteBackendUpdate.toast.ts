import type { RemoteRuntimeUpdateOperation } from "@bigbud/contracts/server/remoteBackendUpdate.ts";

export interface UpdateToast {
  /** Severity drives the shared toast policy duration (no explicit timeouts here). */
  readonly type: "info" | "success" | "warning" | "error";
  readonly title: string;
  readonly description: string;
}

/** Toasts only when the operation or its state changes after the first read (`undefined`), so
 * polling never repeats them and history from before this window opened stays quiet. */
export function updateTransitionToast(
  previous: RemoteRuntimeUpdateOperation | null | undefined,
  next: RemoteRuntimeUpdateOperation | null,
): UpdateToast | null {
  if (!next || previous === undefined) return null;
  const sameOperation = previous?.operationId === next.operationId;
  if (sameOperation && previous?.state === next.state) return null;
  const version = `bigbud ${next.version}`;
  switch (next.state) {
    case "deferred":
      return {
        type: "warning",
        title: "Remote update deferred",
        description: `${version} waits for running work on this backend.`,
      };
    case "activated":
      return {
        type: "success",
        title: "Remote backend updated",
        description: `This backend now runs ${version}.`,
      };
    case "failed":
      return {
        type: "error",
        title: "Remote update failed",
        description: next.failure ?? `${version} could not be installed.`,
      };
    case "cancelled":
      return {
        type: "info",
        title: "Remote update cancelled",
        description: `${version} was not installed.`,
      };
    default:
      return null;
  }
}

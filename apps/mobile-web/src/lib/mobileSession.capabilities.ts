import type { StoredMobileSession } from "./mobileSession";

export function mobileSessionAllowsCommand(
  scope: StoredMobileSession["scope"] | undefined,
  type: string,
): boolean {
  return (
    scope === "thread-control" || (scope === "approve-only" && type === "thread.approval.respond")
  );
}

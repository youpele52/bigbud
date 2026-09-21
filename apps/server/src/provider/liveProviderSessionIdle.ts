import type { ProviderSession } from "@bigbud/contracts";

export function isLiveProviderSessionIdle(
  session: ProviderSession | undefined,
): session is ProviderSession {
  return (
    session !== undefined &&
    session.activeTurnId == null &&
    session.status !== "running" &&
    session.status !== "connecting"
  );
}

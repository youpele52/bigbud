import type { OrchestrationSession, ProviderSession } from "@bigbud/contracts";

import { isLiveProviderSessionIdle } from "../../provider/liveProviderSessionIdle.ts";

export function shouldStampRunningSessionAfterSend(input: {
  readonly liveSession: ProviderSession | undefined;
  readonly sessionAfterTurn: OrchestrationSession | null;
  readonly sessionUnchangedSinceSend: boolean;
}): boolean {
  if (isLiveProviderSessionIdle(input.liveSession)) return false;
  return input.sessionAfterTurn === null || input.sessionUnchangedSinceSend;
}

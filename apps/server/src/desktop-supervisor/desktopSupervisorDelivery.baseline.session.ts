import type { OrchestrationBaselineAckInput } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";

import type { DesktopSupervisorOwner } from "./desktopSupervisorDelivery.ts";
import { installAuthorizedSupervisorBaseline } from "./desktopSupervisorDelivery.baseline.ts";
import type { DesktopSupervisorDeliverySession } from "./desktopSupervisorDelivery.session.ts";

export function installSessionSupervisorBaseline(
  session: DesktopSupervisorDeliverySession,
  baseline: OrchestrationBaselineAckInput,
  serverEpoch: string,
  isAuthoritative: () => boolean,
  startClient: () => Promise<DesktopSupervisorOwner>,
  recover: () => Promise<boolean>,
): Promise<number> {
  return installAuthorizedSupervisorBaseline({
    baseline,
    isCurrent: () => isAuthoritative() && baseline.serverEpoch === serverEpoch,
    install: async (authorizedBaseline) => {
      let client = await startClient();
      if (!session.isAttachedTo(client)) {
        session.clearAttachment();
        if (!(await recover())) {
          throw new Error("desktop supervisor could not reattach before baseline installation");
        }
        client = await startClient();
        if (!session.isAttachedTo(client)) {
          throw new Error("desktop supervisor baseline attachment changed during recovery");
        }
      }
      return client.installBaseline(authorizedBaseline);
    },
  });
}

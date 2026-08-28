import type { OrchestrationBaselineAckInput } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";

import { DesktopSupervisorProtocolError } from "./desktopSupervisorProtocol.ts";

const BASELINE_INSTALL_MAX_ATTEMPTS = 3;

export async function installAuthorizedSupervisorBaseline(input: {
  readonly baseline: OrchestrationBaselineAckInput;
  readonly isCurrent: () => boolean;
  readonly install: (baseline: OrchestrationBaselineAckInput) => Promise<number>;
}): Promise<number> {
  for (let attempt = 1; attempt <= BASELINE_INSTALL_MAX_ATTEMPTS; attempt += 1) {
    if (!input.isCurrent()) {
      throw new Error("desktop supervisor baseline session is no longer authoritative");
    }
    try {
      return await input.install(input.baseline);
    } catch (error) {
      if (
        !(error instanceof DesktopSupervisorProtocolError) ||
        error.code !== "timeout" ||
        attempt === BASELINE_INSTALL_MAX_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw new DesktopSupervisorProtocolError(
    "Desktop supervisor baseline installation retry budget exhausted",
    "timeout",
  );
}

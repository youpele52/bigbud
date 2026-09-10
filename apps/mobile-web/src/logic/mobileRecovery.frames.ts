import type { OrchestrationEvent } from "@bigbud/contracts";

import type { MobileRecoveryFrame } from "@bigbud/contracts/server/mobile.recovery";

import type { MobileRecoveryState } from "./mobileRecovery.types";
import type { createMobileRecoveryEventTracker } from "./mobileRecovery.tracking";

type EventTracker = ReturnType<typeof createMobileRecoveryEventTracker>;

export function applyMobileRecoveryFrame(input: {
  readonly frame: MobileRecoveryFrame;
  readonly runGeneration: number;
  readonly expectedAttemptId: string;
  readonly expectedServerEpoch: string;
  readonly state: MobileRecoveryState;
  readonly currentGeneration: () => number;
  readonly tracker: EventTracker;
  readonly queueEvent: (event: OrchestrationEvent) => boolean;
  readonly flush: () => boolean;
  readonly clearAttemptTimeout: () => void;
  readonly setState: (next: Partial<MobileRecoveryState>) => void;
  readonly fail: (reason: string) => void;
}): void {
  const { frame } = input;
  if (frame.recoveryAttemptId !== input.expectedAttemptId) return;
  if (frame.serverEpoch !== input.expectedServerEpoch) {
    input.fail("server-epoch-changed");
    return;
  }
  if (frame.version !== 1 || frame.route !== "direct-unmanaged") {
    input.fail("unsupported-frame");
    return;
  }
  if (frame.type === "resync-required") {
    input.fail(frame.reason);
    return;
  }
  if (frame.type === "caught-up") {
    if (frame.throughSequence !== input.state.throughSequence) {
      input.fail("caught-up-sequence-mismatch");
      return;
    }
    if (!input.flush() || input.currentGeneration() !== input.runGeneration) return;
    input.clearAttemptTimeout();
    input.setState({
      freshness: "current",
      throughSequence: frame.throughSequence,
      lastSynchronizedAt: Date.now(),
      lastRefreshedAt: null,
      actionsAvailable: true,
      reason: null,
    });
    return;
  }

  if (frame.events.length === 0) {
    input.fail("empty-batch");
    return;
  }
  let throughSequence = input.state.throughSequence ?? -1;
  for (const event of frame.events) {
    const tracking = input.tracker.track(
      event,
      throughSequence,
      input.state.freshness === "current",
    );
    if (tracking === "duplicate") continue;
    if (tracking !== "accepted") {
      input.fail(
        tracking === "overflow"
          ? "overflow"
          : tracking === "sequence-gap"
            ? "event-sequence-gap"
            : "duplicate-event-mismatch",
      );
      return;
    }
    throughSequence = event.sequence;
    if (!input.queueEvent(event)) {
      if (input.currentGeneration() === input.runGeneration) input.fail("overflow");
      return;
    }
  }
  if (input.currentGeneration() === input.runGeneration) {
    input.setState({ throughSequence });
  }
}

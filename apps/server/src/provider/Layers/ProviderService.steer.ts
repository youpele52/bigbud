import { ProviderSteerTurnInput } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import type { ResolveRoutableSession } from "./ProviderService.operations.ts";
import { decodeInputOrValidationError } from "./ProviderServiceHelpers.ts";

export function makeSteerTurn(input: {
  readonly resolveRoutableSession: ResolveRoutableSession;
}): NonNullable<ProviderServiceShape["steerTurn"]> {
  return Effect.fn("steerTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.steerTurn",
      schema: ProviderSteerTurnInput,
      payload: rawInput,
    });
    const routed = yield* input.resolveRoutableSession({
      threadId: parsed.threadId,
      operation: "ProviderService.steerTurn",
      allowRecovery: false,
      ...(parsed.sessionEpoch !== undefined ? { expectedSessionEpoch: parsed.sessionEpoch } : {}),
    });
    if (!routed.adapter.capabilities.supportsSteer || !routed.adapter.steerTurn) {
      return yield* Effect.fail(
        new Error(`Provider '${routed.adapter.provider}' does not support steering.`),
      );
    }
    yield* routed.adapter.steerTurn(routed.threadId, parsed.input, parsed.turnId);
  }) as NonNullable<ProviderServiceShape["steerTurn"]>;
}

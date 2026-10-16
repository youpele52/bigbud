import { ProviderStopSubagentInput } from "@bigbud/contracts/server/subagents";
import { Effect } from "effect";

import { ProviderValidationError } from "../Errors.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import type { ResolveRoutableSession } from "./ProviderService.operations.ts";
import { decodeInputOrValidationError } from "./ProviderServiceHelpers.ts";

const OPERATION = "ProviderService.stopSubagent";

/**
 * Per-subagent Stop (D3). Routes only to a live session (never recovers or starts one) and
 * only when the adapter declares `capabilities.subagents.stop`. Stop-all is `interruptTurn`.
 */
export function makeStopSubagent(input: {
  readonly resolveRoutableSession: ResolveRoutableSession;
}): NonNullable<ProviderServiceShape["stopSubagent"]> {
  return Effect.fn("stopSubagent")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: OPERATION,
      schema: ProviderStopSubagentInput,
      payload: rawInput,
    });
    const routed = yield* input.resolveRoutableSession({
      threadId: parsed.threadId,
      operation: OPERATION,
      allowRecovery: false,
    });
    const stopSubagent = routed.adapter.stopSubagent;
    if (routed.adapter.capabilities.subagents?.stop !== true || !stopSubagent) {
      return yield* new ProviderValidationError({
        operation: OPERATION,
        issue: `Provider '${routed.adapter.provider}' does not support stopping a single subagent.`,
      });
    }
    yield* stopSubagent(routed.threadId, parsed.nativeTaskId);
  });
}

import { Effect } from "effect";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { v2SettlementBusyReason } from "./Runtime.activation.hold.ts";
import { V2PreparationFailed } from "./Admission.ts";

/** The serialized new request may cancel only a drained, exact, never-dispatched foreground row. */
export async function supersedeV2ReservedAdmission(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  validate: () => void,
) {
  const row = owner.row;
  if (
    !row ||
    row.state !== "reserved" ||
    row.namespace !== "foreground" ||
    row.binding.threadId !== owner.threadId ||
    row.binding.nativeSessionId !== owner.native.id ||
    row.binding.storageIdentity !== owner.storageIdentity
  )
    return false;
  const assertDrained = () => {
    validate();
    // This caller owns the serialized admission operation; all other busy fences still apply.
    if (v2SettlementBusyReason(runtime, owner, false))
      throw new V2PreparationFailed({
        detail: "V2 prior preparation has unsettled operations; no new prompt dispatched.",
      });
  };
  assertDrained();
  const inbox = await v2Request("reserved admission input drain", (signal) =>
    owner.lease.process.client.session.inbox.list({ sessionID: owner.native.id }, { signal }),
  );
  assertDrained();
  if (inbox.length)
    throw new V2PreparationFailed({
      detail:
        "V2 prior preparation has queued native input; no reservation cancelled or new prompt dispatched.",
    });
  owner.row = await Effect.runPromise(
    runtime.options.journal.transition(
      row,
      "terminal",
      new Date().toISOString(),
      undefined,
      "interrupted",
    ),
  );
  validate();
  owner.terminalDelivered = true;
  return true;
}

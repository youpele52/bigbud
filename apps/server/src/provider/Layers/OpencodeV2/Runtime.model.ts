import type { ModelRef } from "@opencode/client";
import type { ProviderSendTurnInput } from "@bigbud/contracts/orchestration/provider.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { validateV2TurnInput } from "./Runtime.input.ts";
import { v2ExecutionGuard } from "./Runtime.authorization.ts";
import { assertV2ModelAvailable } from "./Runtime.model.availability.ts";
import { v2ResumeCursor } from "./Runtime.sessions.ts";

/** Resolve a turn selection without silently interpreting another provider or the default model. */
export function v2TurnModel(session: V2RuntimeSession, input: ProviderSendTurnInput): ModelRef {
  const selection = input.modelSelection;
  if (!selection) return session.model;
  if (
    selection.provider !== "opencodeV2" ||
    !selection.subProviderID ||
    selection.model === "default"
  )
    throw new Error("V2 requires an explicit native provider/model.");
  return {
    providerID: selection.subProviderID,
    id: selection.model,
    ...(selection.options?.variant ? { variant: selection.options.variant } : {}),
  };
}

/** Caller holds the session queue. Only new idle admissions can mutate the same owned native model. */
export async function switchV2TurnModel(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  input: ProviderSendTurnInput,
) {
  validateV2TurnInput(session, input);
  const requested = v2TurnModel(session, input);
  if (
    requested.id === session.model.id &&
    requested.providerID === session.model.providerID &&
    (requested.variant ?? "default") === (session.model.variant ?? "default")
  )
    return;
  const guard = v2ExecutionGuard(runtime, session, input.learningJob?.ownerThreadId);
  let validate: (() => void) | undefined;
  const verify = async () => {
    validate?.();
    if (session.stopped || !session.lease.process.isRunning()) return false;
    const native = await v2Request("session.switchModel.verify", (signal) =>
      session.lease.process.client.session.get({ sessionID: session.native.id }, { signal }),
    );
    validate?.();
    if (
      native.id !== session.native.id ||
      native.location.directory !== session.native.location.directory ||
      native.metadata?.bigbud_thread !== session.threadId ||
      native.metadata.bigbud_storage !== session.storageIdentity ||
      native.model?.id !== requested.id ||
      native.model.providerID !== requested.providerID ||
      (native.model.variant ?? "default") !== (requested.variant ?? "default") ||
      session.stopped ||
      !session.lease.process.isRunning()
    )
      return false;
    session.model = requested;
    session.session = {
      ...session.session,
      model: requested.id,
      resumeCursor: v2ResumeCursor(session),
      updatedAt: new Date().toISOString(),
    };
    return true;
  };
  await runtime.mutations.withNamespace(async () => {
    validate = await guard();
    // A setup-only catalog choice must never dispatch a switch or acquire mutation quarantine.
    await assertV2ModelAvailable(
      session.lease.process.client,
      session.native.location.directory,
      requested,
    );
    const active = await v2Request("session.active", (signal) =>
      session.lease.process.client.session.active({ signal }),
    );
    if (
      session.stopped ||
      !session.lease.process.isRunning() ||
      active[session.native.id] ||
      (session.row && (!session.terminalDelivered || session.row.state !== "terminal"))
    )
      throw new Error("V2 model switching requires a confirmed idle owned session.");
    validate = await guard();
    try {
      await runtime.mutations.runOwned(
        session.lease.process,
        "session.switchModel",
        (signal) =>
          session.lease.process.client.session.switchModel(
            { sessionID: session.native.id, model: requested },
            { signal },
          ),
        verify,
        10000,
        undefined,
        true,
        validate,
      );
    } catch (error) {
      // Read back selection for truthful state, but a transport rejection is not raw native settlement.
      // Keep the existing namespace quarantine; never dispatch/resend through this uncertainty.
      await verify().catch(() => false);
      throw error;
    }
  });
}

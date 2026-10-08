import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { ProviderSendTurnInput } from "@bigbud/contracts";
import type { ModelRef } from "@opencode/client";
import type {
  ProviderTurnAdmission,
  ProviderTurnAdmissionIdentity,
} from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { admitV2Turn, V2AdmissionUnconfirmed } from "./Admission.ts";
import { learningAdmissionIdentity } from "./Admission.identity.ts";
import { v2Request } from "./Client.ts";
import { prepareV2Media } from "./Runtime.media.ts";
import { readV2Messages } from "./Runtime.projection.ts";
import type { V2IsolatedRuntimeOptions, V2RuntimeSession } from "./Runtime.types.ts";
import { assertV2Model } from "./Runtime.sessions.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { v2ExecutionPolicy } from "./Runtime.policy.fingerprint.ts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@bigbud/contracts/orchestration/orchestration.provider.ts";

export function runtimePromptFingerprint(
  text: string,
  model: ModelRef,
  mediaDigest: string,
  toolPolicy = v2ExecutionPolicy(),
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        text,
        model.providerID,
        model.id,
        model.variant ?? null,
        mediaDigest,
        toolPolicy,
      ]),
    )
    .digest("hex");
}

export function runtimeAdmissionIdentity(
  input: ProviderSendTurnInput,
): ProviderTurnAdmissionIdentity {
  if (!input.requestMessageId) throw new Error("V2 requires durable requestMessageId.");
  if (!input.learningJob)
    return {
      namespace: "foreground",
      ownerThreadId: input.threadId,
      requestMessageId: input.requestMessageId,
    };
  const learning = learningAdmissionIdentity(
    input.learningJob.ownerThreadId,
    input.learningJob.jobId,
  );
  if (
    learning.threadId !== input.threadId ||
    learning.identity.requestMessageId !== input.requestMessageId
  )
    throw new Error("V2 learning job ownership mismatch.");
  return learning.identity;
}

/** Exact pending/projected identity repairs admission; absence never permits resend. */
export async function observeV2Admission(
  session: V2RuntimeSession,
  row: ProviderTurnAdmission,
): Promise<boolean> {
  const inbox = await v2Request("session.inbox.list", (signal) =>
    session.lease.process.client.session.inbox.list({ sessionID: session.native.id }, { signal }),
  );
  if (inbox.length > 1000) throw new Error("V2 inbox safety bound exceeded.");
  const pending = inbox.find((item) => item.id === row.nativeAdmissionId);
  if (pending)
    return (
      pending.type === "user" &&
      pending.sessionID === session.native.id &&
      pending.delivery === "queue" &&
      pending.payload.metadata?.bigbud_fingerprint === row.fingerprint
    );
  const messages = await readV2Messages(session);
  return messages.some(
    (message) =>
      message.id === row.nativeAdmissionId &&
      message.type === "user" &&
      message.metadata?.bigbud_fingerprint === row.fingerprint,
  );
}

/** Real resume:true dispatch, protected by immutable journal intent and current ownership. */
export async function dispatchV2Turn(
  options: V2IsolatedRuntimeOptions,
  session: V2RuntimeSession,
  input: ProviderSendTurnInput,
) {
  const identity = runtimeAdmissionIdentity(input);
  const native = await v2Request("session.get", (signal) =>
    session.lease.process.client.session.get({ sessionID: session.native.id }, { signal }),
  );
  assertV2Model(native.model, session.model);
  let text = input.input ?? "";
  if (
    !text.trim() ||
    text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS ||
    (input.attachments?.length ?? 0) > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  )
    throw new Error("V2 prompt bounds rejected.");
  if (input.interactionMode && input.interactionMode !== "default")
    throw new Error("V2 non-default interaction mode is not verified.");
  if (input.sessionEpoch !== undefined && input.sessionEpoch !== session.epoch)
    throw new Error("V2 epoch fence rejected.");
  if (
    input.modelSelection &&
    (input.modelSelection.provider !== "opencodeV2" ||
      input.modelSelection.model !== session.model.id ||
      input.modelSelection.subProviderID !== session.model.providerID ||
      input.modelSelection.options?.variant !== session.model.variant)
  )
    throw new Error("V2 model switch requires a separate owned session.");
  if (
    (input.attachments?.length ?? 0) &&
    session.session.providerRuntimeExecutionTargetId !== "local" &&
    !session.resources?.media
  )
    throw new Error(
      "V2 remote media requires an authorized staging transport; no local path fallback.",
    );
  const media = session.resources?.media
    ? await session.resources.media(input)
    : await prepareV2Media(
        input,
        options.allowLocalWorkspace
          ? session.native.location.directory
          : options.config.profileRoot,
        options.attachmentsDir,
      );
  if (media.references)
    text += `\n\nbigbud workspace attachment references (target-bound metadata):\n${media.references}`;
  if (text.length > 120000) throw new Error("V2 prompt plus attachment references exceeds bound.");
  const fingerprint = runtimePromptFingerprint(
    text,
    session.model,
    media.digest,
    session.executionPolicy ??
      v2ExecutionPolicy(
        session.session.runtimeMode,
        Boolean(session.localTools),
        session.toolPolicy ??
          v2LocalToolPolicy(
            session.session.runtimeMode,
            Boolean(session.localTools),
            Boolean(session.coding),
          ),
      ),
  );
  const isCurrent = () => !session.stopped && session.lease.process.isRunning();
  const failure = () =>
    new V2AdmissionUnconfirmed({
      detail: "V2 admission unconfirmed; no automatic resend. New work may duplicate execution.",
    });
  return Effect.runPromise(
    admitV2Turn({
      identity,
      fingerprint,
      binding: {
        provider: "opencodeV2",
        threadId: session.threadId,
        nativeSessionId: session.native.id,
        location: session.native.location.directory,
        storageIdentity: session.storageIdentity,
        runtimeTargetId: session.session.providerRuntimeExecutionTargetId ?? "local",
        workspaceTargetId: session.session.workspaceExecutionTargetId ?? "local",
      },
      isCurrent,
      dispatch: (row) =>
        Effect.tryPromise({
          try: async () => {
            session.row = row;
            const ack = await v2Request("session.prompt", (signal) =>
              session.lease.process.client.session.prompt(
                {
                  sessionID: session.native.id,
                  id: row.nativeAdmissionId,
                  text,
                  files: media.files,
                  metadata: {
                    bigbud_fingerprint: fingerprint,
                    ...(media.references ? { bigbud_attachment_references: media.references } : {}),
                  },
                  delivery: "queue",
                  resume: true,
                },
                { signal },
              ),
            );
            return (
              ack.type === "user" &&
              ack.id === row.nativeAdmissionId &&
              ack.sessionID === session.native.id &&
              ack.delivery === "queue" &&
              ack.payload.metadata?.bigbud_fingerprint === fingerprint
            );
          },
          catch: failure,
        }),
      reconcile: (row) =>
        Effect.tryPromise({
          try: async () =>
            (await observeV2Admission(session, row)) ? ("accepted" as const) : ("unknown" as const),
          catch: failure,
        }),
    }).pipe(Effect.provideService(ProviderTurnAdmissions, options.journal)),
  );
}

import { createHash } from "node:crypto";
import { providerAttachmentIssue } from "@bigbud/shared/providerAttachments";
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
import { readV2Messages } from "./Runtime.projection.ts";
import type { V2IsolatedRuntimeOptions, V2RuntimeSession } from "./Runtime.types.ts";
import { assertV2Model } from "./Runtime.sessions.ts";
import { assertV2ModelAvailable } from "./Runtime.model.availability.ts";
import { v2TurnModel } from "./Runtime.model.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { v2ExecutionPolicy } from "./Runtime.policy.fingerprint.ts";
import { validateV2TurnInput } from "./Runtime.input.ts";
import type { V2PreparedAttachments } from "./Runtime.attachments.ts";
import type { V2RuntimeMutations } from "./Runtime.mutations.ts";
import {
  v2InstructionEntries,
  v2InstructionRevision,
  syncV2Instructions,
} from "./Runtime.instructions.ts";

export function runtimePromptFingerprint(
  text: string,
  model: ModelRef,
  mediaDigest: string,
  toolPolicy = v2ExecutionPolicy(),
  instructionRevision?: string,
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
        ...(instructionRevision ? [instructionRevision] : []),
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
  mutations: V2RuntimeMutations,
  beforeDispatch: () => Promise<() => void>,
  prepared?: V2PreparedAttachments,
) {
  const attachmentIssue = providerAttachmentIssue("opencodeV2", input.attachments);
  if (attachmentIssue) throw new Error(attachmentIssue);
  const identity = runtimeAdmissionIdentity(input);
  const native = await v2Request("session.get", (signal) =>
    session.lease.process.client.session.get({ sessionID: session.native.id }, { signal }),
  );
  assertV2Model(native.model, session.model);
  let text = validateV2TurnInput(session, input);
  // Replays fingerprint their original requested selection, never the session's later model.
  let requestedModel = v2TurnModel(session, input);
  const existing = await Effect.runPromise(options.journal.find(identity));
  if (!existing)
    await assertV2ModelAvailable(
      session.lease.process.client,
      session.native.location.directory,
      requestedModel,
    );
  const entries = v2InstructionEntries(session);
  let instructionRevision = v2InstructionRevision(entries);
  if (existing) {
    // Replays must not refresh context or reinterpret historical pre-instruction admissions.
    const originalMessages = await readV2Messages(session);
    const original = originalMessages.find((message) => message.id === existing.nativeAdmissionId);
    const inbox = original
      ? undefined
      : (
          await v2Request("session.inbox.list", (signal) =>
            session.lease.process.client.session.inbox.list(
              { sessionID: session.native.id },
              { signal },
            ),
          )
        ).find((item) => item.id === existing.nativeAdmissionId);
    const metadata =
      original?.type === "user"
        ? original.metadata
        : inbox?.type === "user"
          ? inbox.payload.metadata
          : undefined;
    if (metadata?.bigbud_fingerprint === existing.fingerprint)
      instructionRevision =
        typeof metadata.bigbud_instruction_revision === "string"
          ? metadata.bigbud_instruction_revision
          : undefined;
    if (!input.modelSelection && original?.type === "user") {
      const index = originalMessages.indexOf(original);
      for (const message of originalMessages.slice(index + 1)) {
        if (message.type === "user" || message.type === "idle") break;
        if (message.type === "assistant") {
          requestedModel = message.model;
          break;
        }
      }
    }
  }
  // Prepared remote sessions historically fingerprinted an empty reference list too.
  // Preserve that text-only replay material without invoking an attachment reader/stager.
  const references =
    prepared?.references ??
    (session.resources?.media && !input.attachments?.length ? "[]" : undefined);
  const media = prepared ?? {
    files: [],
    digest: createHash("sha256")
      .update(references ? "[[],[]]" : "[]")
      .digest("hex"),
  };
  if (input.attachments?.length && !prepared)
    throw new Error("V2 attachments require immutable preparation before admission.");
  if (prepared) text = prepared.text;
  if (references)
    text += `\n\nbigbud workspace attachment references (target-bound metadata):\n${references}`;
  if (text.length > 120000) throw new Error("V2 prompt plus context exceeds bound.");
  const fingerprint = runtimePromptFingerprint(
    text,
    requestedModel,
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
    instructionRevision,
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
            await syncV2Instructions(session, mutations, entries, beforeDispatch);
            const validate = await beforeDispatch();
            if (!isCurrent()) throw failure();
            const ack = await v2Request("session.prompt", (signal) => {
              validate();
              return session.lease.process.client.session.prompt(
                {
                  sessionID: session.native.id,
                  id: row.nativeAdmissionId,
                  text,
                  files: media.files,
                  metadata: {
                    bigbud_fingerprint: fingerprint,
                    ...(instructionRevision
                      ? { bigbud_instruction_revision: instructionRevision }
                      : {}),
                    ...(references ? { bigbud_attachment_references: references } : {}),
                  },
                  delivery: "queue",
                  resume: true,
                },
                { signal },
              );
            });
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

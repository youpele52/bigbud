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
import { admitV2Turn, V2AdmissionUnconfirmed, V2PreparationFailed } from "./Admission.ts";
import { learningAdmissionIdentity } from "./Admission.identity.ts";
import { v2Request } from "./Client.ts";
import { v2HttpFailureStatus } from "./Client.errors.ts";
import { v2SafeFailureSuffix } from "./Client.diagnostics.ts";
import {
  captureV2AsyncContext,
  v2TryPromise,
  withV2CallerAsyncContext,
} from "./Client.guard.async.ts";
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
  validateOwner: () => void,
  prepared?: V2PreparedAttachments,
) {
  const attachmentIssue = providerAttachmentIssue("opencodeV2", input.attachments);
  if (attachmentIssue) throw new Error(attachmentIssue);
  const identity = runtimeAdmissionIdentity(input);
  const native = await v2Request("session.get", (signal) =>
    session.lease.process.client.session.get({ sessionID: session.native.id }, { signal }),
  );
  validateOwner();
  assertV2Model(native.model, session.model);
  let text = validateV2TurnInput(session, input);
  // Replays fingerprint their original requested selection, never the session's later model.
  let requestedModel = v2TurnModel(session, input);
  const existing = await Effect.runPromise(options.journal.find(identity));
  validateOwner();
  if (!existing || existing.state === "reserved")
    await assertV2ModelAvailable(
      session.lease.process.client,
      session.native.location.directory,
      requestedModel,
    );
  validateOwner();
  const entries = v2InstructionEntries(session);
  let instructionRevision = v2InstructionRevision(entries);
  if (existing && existing.state !== "reserved") {
    // Replays must not refresh context or reinterpret historical pre-instruction admissions.
    const originalMessages = await readV2Messages(session);
    validateOwner();
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
    validateOwner();
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
  let fingerprint = runtimePromptFingerprint(
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
  // Native assistant projection materializes the default variant; older omitted selections
  // fingerprinted its absence. Select only an exact match to immutable historical evidence.
  if (
    existing &&
    !input.modelSelection &&
    requestedModel.variant === "default" &&
    fingerprint !== existing.fingerprint
  ) {
    const { variant: _default, ...originalModel } = requestedModel;
    const candidate = runtimePromptFingerprint(
      text,
      originalModel,
      media.digest,
      session.executionPolicy,
      instructionRevision,
    );
    if (candidate === existing.fingerprint) fingerprint = candidate;
  }
  // admitV2Turn calls this from its fiber after journal SQL, where the ambient caller is unreliable.
  const enterCaller = captureV2AsyncContext();
  const isCurrent = () =>
    enterCaller(() => {
      try {
        validateOwner();
        return !session.stopped && session.lease.process.isRunning();
      } catch {
        return false;
      }
    });
  let stage = "preparation";
  let validateDispatch = validateOwner;
  const failure = (error?: unknown) =>
    new V2AdmissionUnconfirmed({
      detail: `V2 ${stage} failed${v2HttpFailureStatus(error) === undefined ? "" : ` (HTTP ${v2HttpFailureStatus(error)})`}. ${stage === "prompt dispatch" || stage === "admission reconciliation" ? "Admission unconfirmed; no automatic resend. New work may duplicate execution." : "No prompt dispatched; retry the same request after resolving preparation."}`,
    });
  validateOwner();
  // Journal I/O inside admitV2Turn is async; callbacks re-enter this caller's request authority.
  return Effect.runPromise(
    withV2CallerAsyncContext(
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
        prepare: (row) =>
          v2TryPromise({
            try: async () => {
              session.row = row;
              stage = "family authorization";
              session.familyPhysicalDrain?.invalidate();
              await session.familyControl?.authorizeInput(row);
              stage = "instruction synchronization";
              await syncV2Instructions(session, mutations, entries, beforeDispatch, (substage) => {
                stage = `instruction synchronization: ${substage}`;
              });
              stage = "execution authorization";
              validateDispatch = await beforeDispatch();
              validateDispatch();
              validateOwner();
            },
            catch: (error) =>
              new V2PreparationFailed({
                detail: `V2 ${stage} failed${v2HttpFailureStatus(error) === undefined ? v2SafeFailureSuffix(error) : ` (HTTP ${v2HttpFailureStatus(error)})`}. No prompt dispatched; retry the same request after resolving preparation.`,
              }),
          }),
        dispatch: (row) =>
          v2TryPromise({
            try: async () => {
              session.row = row;
              stage = "prompt dispatch";
              const validate = validateDispatch;
              if (!isCurrent()) throw failure();
              const ack = await v2Request("session.prompt", (signal) => {
                validate();
                const prompt = () =>
                  session.lease.process.client.session.prompt(
                    {
                      sessionID: session.native.id,
                      id: row.nativeAdmissionId,
                      text,
                      files: media.files,
                      metadata: {
                        bigbud_fingerprint: fingerprint,
                        ...(session.familyControl
                          ? {
                              bigbud_family_generation: session.family!.generation,
                              bigbud_family_root: session.native.id,
                            }
                          : {}),
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
                const activation = session.activation;
                return activation?.token
                  ? activation.gate.dispatch(activation.token, prompt)
                  : prompt();
              });
              validate();
              validateOwner();
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
          v2TryPromise({
            try: async () => {
              stage = "admission reconciliation";
              const observed = await observeV2Admission(session, row);
              validateOwner();
              return observed ? ("accepted" as const) : ("unknown" as const);
            },
            catch: failure,
          }),
      }).pipe(Effect.provideService(ProviderTurnAdmissions, options.journal)),
    ),
  );
}

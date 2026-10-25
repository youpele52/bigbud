import { createHash } from "node:crypto";
import { EventId, RuntimeRequestId } from "@bigbud/contracts/core/baseSchemas";
import type {
  ProviderRuntimeEvent,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
} from "@bigbud/contracts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { readV2OwnedChild } from "./Runtime.family.ts";
import { pendingV2Interactions, replyV2Permission, replyV2Form } from "./Runtime.interactions.ts";
import { v2ReplyGuard } from "./Runtime.replies.ts";
import { installV2UnsupportedFormCanceller } from "./Runtime.forms.unsupported.ts";
import { v2Request } from "./Client.ts";
import { v2PermissionFingerprint } from "./Runtime.approvalIntent.ts";
import { formQuestions } from "./Runtime.forms.ts";
import {
  v2FamilyInteractionState,
  type V2FamilyInteractionTarget,
} from "./Runtime.family.interactions.state.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Child reads/replies reuse native interaction, consent and mutation quarantine code with the exact child target. */
export async function pendingV2FamilyInteractions(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  validate: () => void,
) {
  if (!owner.family || owner.family.isFenced) return;
  const qualification = owner.familyQualification ?? runtime.options.nativeSubagents?.qualification;
  if (!qualification) return;
  qualification.assertCurrent();
  const retained = v2FamilyInteractionState(owner);
  for (const child of owner.family.children) {
    if ((child.generation ?? 0) !== owner.family.generation || child.state === "uncertain")
      continue;
    if (
      child.state === "terminal" &&
      ![...retained.targets.values()].some((target) => target.view.native.id === child.id)
    )
      continue;
    const native = await readV2OwnedChild(owner, child);
    validate();
    let view = retained.views.get(child.id);
    if (!view) {
      const { coding: _coding, ...nativeOwner } = owner;
      view = {
        ...nativeOwner,
        native,
        row: undefined,
        messages: new Map(),
        emitted: new Set(),
        pendingInteractions: new Map(),
      };
      retained.views.set(child.id, view);
      installV2UnsupportedFormCanceller(runtime, view, owner);
      const target = view;
      target.rejectUnsafePermission = (id) =>
        replyV2Permission(
          target,
          id,
          "decline",
          runtime.mutations,
          v2ReplyGuard(runtime.options, runtime.sessions, owner),
        );
    }
    const events = await pendingV2Interactions(view);
    validate();
    const present = new Set<string>();
    for (const event of events) {
      if (!event.requestId) continue;
      const rawId = event.requestId;
      const kind = event.type.startsWith("user-input") ? "form" : "permission";
      if (event.type !== "request.opened" && event.type !== "user-input.requested") continue;
      if (owner.family.child(child.id)?.state !== "enrolled") continue;
      let fingerprint: string;
      if (event.type === "request.opened") {
        if (!event.payload.executionIntent)
          throw new Error("V2 child approval intent is unavailable.");
        const intent = JSON.parse(event.payload.executionIntent.content) as { resources?: unknown };
        if (
          !Array.isArray(intent.resources) ||
          !intent.resources.length ||
          intent.resources.length > 128 ||
          intent.resources.some(
            (resource) => typeof resource !== "string" || !resource || resource.length > 4096,
          )
        ) {
          await view.rejectUnsafePermission?.(rawId);
          continue;
        }
        fingerprint = v2PermissionFingerprint(intent);
      } else {
        const form = await v2Request("owned child form.get", (signal) =>
          owner.lease.process.client.session.form.get(
            { sessionID: child.id, formID: rawId },
            { signal },
          ),
        );
        if (JSON.stringify(formQuestions(form)) !== JSON.stringify(event.payload.questions))
          throw new Error("V2 child form changed during discovery.");
        fingerprint = hash(form);
      }
      validate();
      const id = `bbv2-child:${hash([child.taskId, owner.epoch, owner.lease.generation, owner.family.generation, kind, rawId, fingerprint])}`;
      if (!retained.targets.has(id) && retained.targets.size >= 128)
        throw new Error("V2 family interaction capacity exceeded; Stop remains available.");
      present.add(id);
      const mapped = attributeV2ChildInteraction(
        event,
        id,
        child.agent,
        child.description,
        child.id,
        child.taskId,
      );
      await runtime.emit(owner, mapped, validate);
      if (event.type === "request.opened" || event.type === "user-input.requested") {
        retained.targets.set(id, {
          opened: mapped,
          view,
          rawId,
          kind,
          fingerprint,
          taskId: child.taskId,
          generation: owner.family.generation,
        });
      }
    }
    // Disappearance is cancellation of the exact observed request, not an invitation to answer another request with a reused ID.
    for (const [id, target] of retained.targets) {
      if (target.view !== view || present.has(id)) continue;
      const resolved = events.find(
        (event) =>
          event.requestId === target.rawId &&
          (event.type === "request.resolved" || event.type === "user-input.resolved"),
      );
      await runtime.emit(
        owner,
        attributeV2ChildInteraction(
          resolved ??
            ({
              provider: "opencodeV2",
              threadId: owner.threadId,
              eventId: `v2:child-disappeared:${id}` as ProviderRuntimeEvent["eventId"],
              createdAt: new Date().toISOString(),
              sessionEpoch: owner.epoch,
              ...(target.kind === "permission"
                ? {
                    type: "request.resolved",
                    payload: {
                      requestType:
                        target.opened.type === "request.opened"
                          ? target.opened.payload.requestType
                          : "command_execution_approval",
                      decision: "cancel",
                    },
                  }
                : { type: "user-input.resolved", payload: { answers: {} } }),
            } as ProviderRuntimeEvent),
          id,
          child.agent,
          child.description,
          child.id,
          child.taskId,
        ),
        validate,
      );
      retained.targets.delete(id);
    }
  }
}

/** Invalidates UI reply authority at Stop without claiming native cancellation succeeded. */
export async function closeV2FamilyInteractions(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
) {
  for (const [id, target] of v2FamilyInteractionState(owner).targets) {
    const event: ProviderRuntimeEvent = {
      provider: "opencodeV2",
      threadId: owner.threadId,
      eventId: `v2:child-stop:${id}` as ProviderRuntimeEvent["eventId"],
      createdAt: new Date().toISOString(),
      sessionEpoch: owner.epoch,
      requestId: RuntimeRequestId.makeUnsafe(id),
      ...(target.kind === "permission"
        ? {
            type: "request.resolved",
            payload: {
              requestType:
                target.opened.type === "request.opened"
                  ? target.opened.payload.requestType
                  : "command_execution_approval",
              decision: "cancel",
            },
          }
        : { type: "user-input.resolved", payload: { answers: {} } }),
    };
    await runtime.emit(owner, event);
    v2FamilyInteractionState(owner).targets.delete(id);
  }
}

function attributeV2ChildInteraction(
  event: ProviderRuntimeEvent,
  id: string,
  agent: string,
  description: string,
  nativeId: string,
  taskId: string,
): ProviderRuntimeEvent {
  // Child requests are not root turn liveness, even when the main turn is still open.
  const { turnId: _turn, ...nativeBase } = event;
  const base = { ...nativeBase, eventId: EventId.makeUnsafe(`${event.eventId}:${id}`) };
  const requestId = RuntimeRequestId.makeUnsafe(id);
  if (event.type === "request.opened")
    return {
      ...base,
      requestId,
      type: event.type,
      payload: {
        ...event.payload,
        detail: `[${agent}] ${description}: ${event.payload.detail ?? "Permission"}`.slice(0, 1024),
        args: { nativeSessionId: nativeId, subagentTaskId: taskId, native: event.payload.args },
      },
    };
  if (event.type === "user-input.requested")
    return {
      ...base,
      requestId,
      type: event.type,
      payload: {
        questions: event.payload.questions.map((question) => ({
          ...question,
          header: `[${agent}] ${question.header}`.slice(0, 128),
          question: `${description}\n${question.question}`.slice(0, 4096),
        })),
      },
    };
  return { ...base, requestId } as ProviderRuntimeEvent;
}

/** Resolve a collision-safe opaque UI ID only in its current root/generation and recheck the originally displayed intent. */
export async function replyV2FamilyInteraction(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  id: string,
  reply: ProviderApprovalDecision | ProviderUserInputAnswers,
  expectedKind: V2FamilyInteractionTarget["kind"],
) {
  const target = v2FamilyInteractionState(owner).targets.get(id);
  if (!target || target.kind !== expectedKind || !owner.family || owner.family.isFenced)
    throw new Error("V2 stale/unknown child request.");
  const child = owner.family.child(target.view.native.id);
  if (
    !child ||
    child.taskId !== target.taskId ||
    child.state !== "enrolled" ||
    (child.generation ?? 0) !== owner.family.generation ||
    target.generation !== owner.family.generation
  )
    throw new Error("V2 child reply ownership lost.");
  const baseGuard = v2ReplyGuard(runtime.options, runtime.sessions, owner);
  const guard = async () => {
    const qualification =
      owner.familyQualification ?? runtime.options.nativeSubagents?.qualification;
    if (!qualification) throw new Error("V2 child reply policy qualification unavailable.");
    qualification.assertCurrent();
    const validate = await baseGuard();
    await readV2OwnedChild(owner, child);
    const fresh =
      target.kind === "permission"
        ? v2PermissionFingerprint(
            await v2Request("owned child permission.get", (signal) =>
              owner.lease.process.client.permission.get(
                { sessionID: child.id, requestID: target.rawId },
                { signal },
              ),
            ),
          )
        : hash(
            await v2Request("owned child form.get", (signal) =>
              owner.lease.process.client.session.form.get(
                { sessionID: child.id, formID: target.rawId },
                { signal },
              ),
            ),
          );
    if (fresh !== target.fingerprint) throw new Error("V2 displayed child request intent changed.");
    const generation = target.generation;
    const current = () => {
      qualification.assertCurrent();
      validate();
      owner.family!.assertSpawn(generation);
      if (v2FamilyInteractionState(owner).targets.get(id) !== target)
        throw new Error("V2 child request replaced.");
    };
    current();
    return current;
  };
  await guard();
  const event =
    target.kind === "permission"
      ? await replyV2Permission(
          target.view,
          target.rawId,
          reply as ProviderApprovalDecision,
          runtime.mutations,
          guard,
        )
      : await replyV2Form(
          target.view,
          target.rawId,
          reply as ProviderUserInputAnswers,
          runtime.mutations,
          guard,
        );
  await runtime.emit(
    owner,
    attributeV2ChildInteraction(event, id, child.agent, child.description, child.id, child.taskId),
  );
  v2FamilyInteractionState(owner).targets.delete(id);
  target.view.pendingInteractions?.delete(
    `${target.kind === "permission" ? "request.opened" : "user-input.requested"}:${target.rawId}`,
  );
}

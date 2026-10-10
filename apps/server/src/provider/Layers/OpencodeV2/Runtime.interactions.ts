import { RuntimeRequestId } from "@bigbud/contracts/core/baseSchemas";
import type {
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { v2Request } from "./Client.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";
import type { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { formQuestions, formAnswer } from "./Runtime.forms.ts";
import { invalidateV2Interactions } from "./Runtime.interactions.pending.ts";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { boundedV2ApprovalIntent, v2PermissionFingerprint } from "./Runtime.approvalIntent.ts";

function permissionType(action: string) {
  return action === "edit" || action.includes("write")
    ? ("file_change_approval" as const)
    : action === "read"
      ? ("file_read_approval" as const)
      : ("command_execution_approval" as const);
}

/** Refresh pending interaction ownership from native state before exposing or answering. */
export async function pendingV2Interactions(
  session: V2RuntimeSession,
): Promise<ProviderRuntimeEvent[]> {
  const client = session.lease.process.client;
  const [permissions, forms] = await Promise.all([
    v2Request("permission.list", (signal) =>
      client.permission.list({ sessionID: session.native.id }, { signal }),
    ),
    v2Request("session.form.list", (signal) =>
      client.session.form.list({ sessionID: session.native.id }, { signal }),
    ),
  ]);
  if (permissions.length + forms.length > 128)
    throw new Error("V2 pending interaction bound exceeded.");
  const events: ProviderRuntimeEvent[] = [...(session.coding?.pending() ?? [])];
  for (const retained of session.pendingInteractions?.values() ?? [])
    if (retained.type === "request.resolved") events.push(retained);
  const observedAnswers = new Map<string, Record<string, unknown>>();
  for (const [key, opened] of session.pendingInteractions ?? []) {
    if (
      opened.type !== "user-input.requested" ||
      !opened.requestId ||
      forms.some((form) => form.id === opened.requestId)
    )
      continue;
    const formID = opened.requestId;
    const settled = await v2Request("session.form.get", (signal) =>
      client.session.form.get({ sessionID: session.native.id, formID }, { signal }),
    );
    if (
      settled.id !== opened.requestId ||
      settled.sessionID !== session.native.id ||
      settled.state.status === "pending"
    )
      throw new Error("V2 disappeared form settlement is unconfirmed.");
    if (settled.state.status === "answered") observedAnswers.set(key, settled.state.answer);
  }
  for (const request of permissions) {
    if (request.sessionID !== session.native.id)
      throw new Error("V2 permission ownership mismatch.");
    if (session.pendingInteractions?.has(`request.resolved:${request.id}`)) continue;
    const executionIntent = boundedV2ApprovalIntent(request);
    if (!executionIntent) {
      // Never publish an uninspectable Allow action. Denial uses the same settings/owner/generation/quarantine fences as a normal reply.
      const rejected = await session.rejectUnsafePermission?.(request.id).catch(() => undefined);
      if (rejected)
        events.push({
          ...rejected,
          payload: {
            ...rejected.payload,
            resolution: {
              reason:
                "Native permission intent exceeded the inspectable bound; rejected without approval.",
            },
          },
        });
      continue;
    }
    events.push({
      ...runtimeEventBase(session, `permission:${request.id}`),
      requestId: RuntimeRequestId.makeUnsafe(request.id),
      type: "request.opened",
      payload: {
        requestType: permissionType(request.action),
        detail: (request.message ?? `Permission: ${request.action}`).slice(0, 1024),
        args: { action: request.action, resources: request.resources },
        sessionApprovalAvailable: false,
        executionIntent,
      },
    });
  }
  for (const form of forms) {
    if (form.sessionID !== session.native.id) throw new Error("V2 form ownership mismatch.");
    let questions;
    try {
      questions = formQuestions(form);
    } catch (error) {
      if (!session.cancelUnsupportedForm) throw error;
      await session.cancelUnsupportedForm(form);
      continue;
    }
    events.push({
      ...runtimeEventBase(session, `form:${form.id}`),
      requestId: RuntimeRequestId.makeUnsafe(form.id),
      type: "user-input.requested",
      payload: { questions },
    });
  }
  if (session.stopped || !session.lease.process.isRunning()) return [];
  session.pendingInteractions ??= new Map();
  const retained = new Set<string>();
  for (const event of events) {
    const key = `${event.type}:${event.requestId}`;
    retained.add(key);
    if (event.type === "request.resolved") retained.add(`request.opened:${event.requestId}`);
    session.pendingInteractions.set(key, event);
  }
  events.push(...invalidateV2Interactions(session, retained, observedAnswers));
  return events;
}

export async function replyV2Permission(
  session: V2RuntimeSession,
  id: string,
  decision: ProviderApprovalDecision,
  mutations: V2RuntimeMutations,
  beforeDispatch: () => Promise<() => void>,
) {
  if (session.stopped || !session.lease.process.isRunning())
    throw new Error("V2 permission generation lost.");
  if (decision === "acceptForSession")
    throw new Error("V2 persistent approvals are unavailable in isolated execution.");
  const client = session.lease.process.client;
  const request = await v2Request("permission.get", (signal) =>
    client.permission.get({ sessionID: session.native.id, requestID: id }, { signal }),
  );
  if (request.id !== id || request.sessionID !== session.native.id || session.stopped)
    throw new Error("V2 stale permission.");
  // The isolated harness denies all tool execution, even after an UI approval.
  if (
    decision === "accept" &&
    (!session.localTools ||
      (request.resources.length ? request.resources : ["*"]).some(
        (resource) =>
          v2PermissionEffect(
            session.toolPolicy ?? v2LocalToolPolicy(session.session.runtimeMode, true),
            request.action,
            resource,
          ) === "deny",
      ))
  )
    throw new Error("V2 isolated execution cannot approve tools.");
  if (decision === "accept" && !boundedV2ApprovalIntent(request))
    throw new Error(
      "V2 native permission intent exceeds the inspectable bound; acceptance is unavailable.",
    );
  const fingerprint = v2PermissionFingerprint(request);
  await mutations.run(
    session,
    "permission.reply",
    (signal) =>
      client.permission.reply(
        {
          sessionID: session.native.id,
          requestID: id,
          decision: decision === "accept" ? "once" : "reject",
        },
        { signal },
      ),
    async () => false,
    10000,
    async () => {
      await beforeDispatch();
      const fresh = await v2Request("permission.get", (signal) =>
        client.permission.get({ sessionID: session.native.id, requestID: id }, { signal }),
      );
      if (v2PermissionFingerprint(fresh) !== fingerprint)
        throw new Error("V2 stale permission changed before dispatch.");
      return beforeDispatch();
    },
  );
  return {
    ...runtimeEventBase(session, `permission-resolved:${id}`),
    requestId: RuntimeRequestId.makeUnsafe(id),
    type: "request.resolved" as const,
    payload: { requestType: permissionType(request.action), decision },
  };
}

export async function replyV2Form(
  session: V2RuntimeSession,
  id: string,
  answers: ProviderUserInputAnswers,
  mutations: V2RuntimeMutations,
  beforeDispatch: () => Promise<() => void>,
) {
  const client = session.lease.process.client;
  const form = await v2Request("session.form.get", (signal) =>
    client.session.form.get({ sessionID: session.native.id, formID: id }, { signal }),
  );
  if (
    form.id !== id ||
    form.sessionID !== session.native.id ||
    form.state.status !== "pending" ||
    session.stopped ||
    !session.lease.process.isRunning()
  )
    throw new Error("V2 stale form ownership.");
  const answer = formAnswer(form, answers);
  await mutations.run(
    session,
    "session.form.reply",
    (signal) =>
      client.session.form.reply({ sessionID: session.native.id, formID: id, answer }, { signal }),
    async () => false,
    10000,
    async () => {
      await beforeDispatch();
      const fresh = await v2Request("session.form.get", (signal) =>
        client.session.form.get({ sessionID: session.native.id, formID: id }, { signal }),
      );
      if (fresh.state.status !== "pending" || JSON.stringify(fresh) !== JSON.stringify(form))
        throw new Error("V2 stale form changed before dispatch.");
      return beforeDispatch();
    },
  );
  return {
    ...runtimeEventBase(session, `form-resolved:${id}`),
    requestId: RuntimeRequestId.makeUnsafe(id),
    type: "user-input.resolved" as const,
    payload: { answers: answer },
  };
}

import type { SessionInfo, PermissionRuleset } from "@opencode/client";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { V2OwnedFamily, type V2OwnedChild } from "./Subagents.ownership.ts";
import { v2Request } from "./Client.ts";
import { assertV2SavedGrantsCompatible } from "./Runtime.permissions.saved.ts";
import { v2ReplyGuard } from "./Runtime.replies.ts";
import { v2ExecutionPolicy } from "./Runtime.policy.fingerprint.ts";

export interface V2ChildLaunch {
  readonly sessionID: string;
  readonly parentSessionID: string;
  readonly messageID: string;
  readonly callID: string;
  readonly agent: string;
  readonly description: string;
  readonly prompt: string;
  readonly background: boolean;
}
export interface V2SubagentQualification {
  /** Must attest pinned executor ordering, exclusive/final policy hook and exact artifact bytes. */
  readonly assertCurrent: () => void;
  readonly attach: (
    owner: V2RuntimeSession,
    beforePrompt: (launch: V2ChildLaunch) => Promise<void>,
    beforeSpawn: (parentSessionId: string, continuationId?: string) => Promise<void>,
  ) => Promise<() => void | Promise<void>>;
}

/** Restores ownership before any history repair. Merely observing a child never enrolls it. */
export async function attachV2OwnedFamily(runtime: OpencodeV2Runtime, owner: V2RuntimeSession) {
  if (owner.detachSubagentGuard) throw new Error("V2 native family guard is already attached.");
  const options = runtime.options.nativeSubagents;
  if (!options) return;
  owner.family = await V2OwnedFamily.open(options.stateDirectory, {
    storageIdentity: owner.storageIdentity,
    rootId: owner.native.id,
    threadId: owner.threadId,
  });
  if (owner.family.isFenced && owner.family.live)
    owner.executionBlocked =
      "V2 descendant cancellation recovery remains pending; Stop to confirm settlement.";
  const qualification = options.qualification ?? (await options.prepare?.(owner, runtime));
  owner.familyQualification = qualification;
  if (!qualification || !owner.localTools) {
    if (owner.family.live)
      owner.executionBlocked =
        "V2 descendant policy qualification is unavailable; ownership retained. Stop to cancel existing work.";
    return;
  }
  qualification.assertCurrent();
  owner.detachSubagentGuard = await qualification.attach(
    owner,
    (launch) => beforeV2ChildPrompt(runtime, owner, launch),
    async (parentId, continuationId) => {
      await v2ReplyGuard(runtime.options, runtime.sessions, owner)();
      qualification.assertCurrent();
      if (parentId !== owner.native.id && !owner.family!.child(parentId))
        throw new Error("V2 spawn parent is not owned.");
      owner.family!.assertCapacity(continuationId);
      if (continuationId && owner.family!.child(continuationId)!.parentId !== parentId)
        throw new Error("V2 continued child belongs to another parent.");
    },
  );
  // Guard attachment is already authenticated. Its native fence remains authoritative
  // until a distinct immutable user admission rearms it; policy alone cannot execute.
  const permissions: PermissionRuleset = [
    ...(owner.toolPolicy ?? []),
    {
      action: "subagent",
      resource: "*",
      effect: owner.session.runtimeMode === "full-access" ? "allow" : "ask",
    },
  ];
  await runtime.mutations.run(
    owner,
    "qualified root subagent policy",
    (signal) =>
      owner.lease.process.client.session.update(
        { sessionID: owner.native.id, permissions },
        { signal },
      ),
    async () => false,
    10000,
    async () => {
      qualification.assertCurrent();
      return () => {
        qualification.assertCurrent();
      };
    },
  );
  Object.assign(owner, {
    toolPolicy: permissions,
    executionPolicy: v2ExecutionPolicy(owner.session.runtimeMode, true, permissions),
  });
}

/** Authoritative native read, checked against durable BEFORE-execution enrollment, never parentID discovery alone. */
export async function readV2OwnedChild(
  owner: V2RuntimeSession,
  child: V2OwnedChild,
): Promise<SessionInfo> {
  if (owner.family?.child(child.id)?.taskId !== child.taskId)
    throw new Error("V2 descendant ownership lost.");
  const native = await v2Request("owned child session.get", (signal) =>
    owner.lease.process.client.session.get({ sessionID: child.id }, { signal }),
  );
  if (
    native.id !== child.id ||
    native.parentID !== child.parentId ||
    native.fork ||
    native.location.directory !== owner.native.location.directory ||
    native.projectID !== owner.native.projectID ||
    native.metadata?.bigbud_storage !== owner.storageIdentity ||
    native.metadata.bigbud_thread !== owner.threadId ||
    native.metadata.bigbud_provider !== "opencodeV2"
  )
    throw new Error("V2 enrolled descendant native lineage/location/storage mismatch.");
  return native;
}

/** Invoked by the native executor's awaited progress BEFORE its prompt, for both new and resumed children. */
export async function beforeV2ChildPrompt(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  launch: V2ChildLaunch,
) {
  const qualification = owner.familyQualification ?? runtime.options.nativeSubagents?.qualification;
  if (!qualification || !owner.family) throw new Error("V2 child guard qualification unavailable.");
  qualification.assertCurrent();
  owner.family.assertSpawn();
  const family = owner.family;
  const generation = family.generation;
  const ownerGuard = await v2ReplyGuard(runtime.options, runtime.sessions, owner)();
  const guard = () => {
    ownerGuard();
    family.assertSpawn(generation);
  };
  const parent =
    launch.parentSessionID === owner.native.id ? undefined : family.child(launch.parentSessionID);
  if (launch.parentSessionID !== owner.native.id && !parent)
    throw new Error("V2 native child parent is not owned.");
  const native = await v2Request("before-prompt child.get", (signal) =>
    owner.lease.process.client.session.get({ sessionID: launch.sessionID }, { signal }),
  );
  if (
    native.id === owner.native.id ||
    native.id !== launch.sessionID ||
    native.parentID !== launch.parentSessionID ||
    native.fork ||
    native.projectID !== owner.native.projectID ||
    native.location.directory !== owner.native.location.directory ||
    native.metadata?.bigbud_storage !== owner.storageIdentity ||
    native.metadata.bigbud_thread !== owner.threadId ||
    native.agent !== launch.agent
  )
    throw new Error("V2 before-prompt native child provenance rejected.");
  const active = await v2Request("before-prompt child.active", (signal) =>
    owner.lease.process.client.session.active({ signal }),
  );
  if (active[native.id])
    throw new Error("V2 child continuation must be idle before policy enrollment.");
  await assertV2SavedGrantsCompatible(owner.lease.process.client, native, owner.toolPolicy);
  guard();
  qualification.assertCurrent();
  family.assertSpawn();
  // Remove the inherited APP overlay, not the child's agent configuration or its own
  // session overlay. Parent restrictions remain independently enforced by the final clamp.
  const restrictions: PermissionRuleset = (native.permissions ?? []).filter(
    (rule) =>
      !owner.toolPolicy?.some((parentRule) => JSON.stringify(parentRule) === JSON.stringify(rule)),
  );
  await runtime.mutations.run(
    owner,
    "child session.update",
    (signal) =>
      owner.lease.process.client.session.update(
        { sessionID: native.id, permissions: restrictions },
        { signal },
      ),
    async () => false,
    10000,
    async () => {
      guard();
      qualification.assertCurrent();
      family.assertSpawn();
      return () => {
        guard();
        qualification.assertCurrent();
        family.assertSpawn();
      };
    },
  );
  guard();
  qualification.assertCurrent();
  family.assertSpawn();
  const message = owner.messages.get(launch.messageID);
  const exactLaunch =
    message?.type === "assistant" &&
    message.content.some(
      (part) =>
        part.type === "tool" &&
        part.id === launch.callID &&
        part.name === "subagent" &&
        part.state.status !== "streaming" &&
        part.state.input.agent === launch.agent &&
        part.state.input.prompt === launch.prompt &&
        part.state.input.description === launch.description &&
        (part.state.input.background === true) === launch.background,
    );
  await family.enroll({
    id: native.id,
    parentId: launch.parentSessionID,
    agent: launch.agent,
    description: launch.description,
    prompt: launch.prompt,
    messageId: launch.messageID,
    callId: launch.callID,
    background: launch.background,
    nativeRevision: Math.max(native.time.updated, native.time.idle ?? 0),
    ...(owner.row?.state === "accepted" && !parent && exactLaunch
      ? { turnId: owner.row.turnId }
      : {}),
  });
  guard();
  qualification.assertCurrent();
  family.assertSpawn();
  owner.lease.hub.noteOwnedChildren(
    owner.native.id,
    family.children.filter((child) => child.state !== "terminal").map((child) => child.id),
  );
  runtime.scheduleRepair(owner, false);
}

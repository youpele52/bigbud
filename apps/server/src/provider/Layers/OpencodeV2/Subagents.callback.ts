import { Schema } from "effect";
import { v2Request } from "./Client.ts";
import type { NativeFamilyCallback, NativeFamilyRegistration } from "./Subagents.protocol.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2ChildLaunch } from "./Runtime.family.ts";
import { readV2OwnedChild } from "./Runtime.family.ts";
import { assertV2SavedGrantsCompatible } from "./Runtime.permissions.saved.ts";
import { v2ChildPermissionCeiling } from "./Subagents.ceiling.ts";
import { nativeFamilyHash } from "./Subagents.protocol.ts";

export interface V2NativeFamilyOwner {
  readonly owner: V2RuntimeSession;
  readonly runtime: OpencodeV2Runtime;
  readonly registration: NativeFamilyRegistration;
  readonly assertCurrent: () => void;
  readonly refresh: () => Promise<void>;
  readonly beforePrompt: (launch: V2ChildLaunch) => Promise<void>;
  readonly beforeSpawn: (parent: string, continuation?: string) => Promise<void>;
  readonly seen: Map<string, number>;
}
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Launch = Schema.Struct({
  sessionID: Id,
  parentSessionID: Id,
  messageID: Id,
  callID: Id,
  agent: Id,
  description: Id,
  prompt: Schema.String.check(Schema.isMaxLength(16384)),
  background: Schema.Boolean,
});
const Permission = Schema.Struct({
  action: Id,
  resources: Schema.Array(Id),
  nativeEffect: Schema.Literals(["allow", "ask", "deny"]),
  agent: Schema.NullOr(Id),
});

/** Encrypted callbacks are still untrusted input: exact registration, graph and generation precede any mutation. */
export async function handleV2NativeFamilyCallback(
  entry: V2NativeFamilyOwner,
  request: NativeFamilyCallback,
) {
  entry.assertCurrent();
  const { owner, runtime, registration } = entry;
  if (
    request.rootId !== owner.native.id ||
    request.nonce !== registration.nonce ||
    request.epoch !== owner.epoch ||
    request.transportGeneration !== registration.transportGeneration ||
    request.generation !== owner.family!.generation
  )
    throw new Error("V2 native family callback owner/generation mismatch.");
  for (const [nonce, expires] of entry.seen) if (expires <= Date.now()) entry.seen.delete(nonce);
  if (
    request.expires <= Date.now() ||
    request.expires > Date.now() + 10000 ||
    entry.seen.has(request.requestNonce) ||
    entry.seen.size >= 4096
  )
    throw new Error("V2 native family callback replay/capacity rejected.");
  entry.seen.set(request.requestNonce, request.expires);
  await entry.refresh();
  entry.assertCurrent();
  if (request.kind === "probe") return { active: true };
  owner.family!.assertSpawn(request.generation);
  const child =
    request.sessionId === owner.native.id ? undefined : owner.family!.child(request.sessionId);
  if (
    request.sessionId !== owner.native.id &&
    (!child || (child.generation ?? 0) !== request.generation)
  )
    throw new Error("V2 native child authority is absent or retired.");
  if (child) await readV2OwnedChild(owner, child);
  entry.assertCurrent();
  owner.family!.assertSpawn(request.generation);
  if (request.kind === "spawn") {
    // Pinned public APIs do not expose the internal job notification ID before synthetic
    // admission. No boolean qualification flag can bypass the missing receipt mechanism.
    if (request.payload.background !== false && !owner.familyControl?.nativeReceipt)
      throw new Error(
        "V2 native background spawning requires authenticated BEFORE-synthetic-admission receipts, unavailable in the pinned public API.",
      );
    const continuation = request.payload.continuationId;
    if (continuation !== null && typeof continuation !== "string")
      throw new Error("V2 native child continuation is malformed.");
    await entry.beforeSpawn(request.sessionId, continuation ?? undefined);
    const message = Schema.decodeUnknownSync(Id)(request.payload.messageId);
    const call = Schema.decodeUnknownSync(Id)(request.payload.callId);
    await owner.family!.reserveSpawn(
      nativeFamilyHash([request.generation, request.sessionId, message, call]),
    );
    return { active: true };
  }
  if (request.kind === "enroll-child") {
    const launch = Schema.decodeUnknownSync(Launch)(request.payload, { onExcessProperty: "error" });
    if (
      launch.parentSessionID !== request.sessionId ||
      (launch.background && !owner.familyControl?.nativeReceipt)
    )
      throw new Error("V2 native child launch parent/background provenance rejected.");
    const receipt = nativeFamilyHash([
      request.generation,
      launch.parentSessionID,
      launch.messageID,
      launch.callID,
    ]);
    owner.family!.assertSpawnReceipt(receipt);
    await entry.beforePrompt(launch);
    await owner.family!.execution(launch.sessionID, receipt, "started");
    await owner.family!.completeSpawn(receipt);
    return { active: true };
  }
  if (request.kind === "executor-settled") {
    if (!child) throw new Error("V2 executor settlement must target an enrolled child.");
    const receipt = Schema.decodeUnknownSync(Id)(request.payload.receipt);
    const status = Schema.decodeUnknownSync(Schema.Literals(["completed", "running", "uncertain"]))(
      request.payload.status,
    );
    await owner.family!.execution(child.id, receipt, status);
    return { active: true };
  }
  if (request.kind === "permission") {
    const permission = Schema.decodeUnknownSync(Permission)(request.payload, {
      onExcessProperty: "error",
    });
    const native = child
      ? await readV2OwnedChild(owner, child)
      : await v2Request("family permission root", (signal) =>
          owner.lease.process.client.session.get({ sessionID: owner.native.id }, { signal }),
        );
    await assertV2SavedGrantsCompatible(owner.lease.process.client, native, owner.toolPolicy);
    const agentID = permission.agent ?? native.agent;
    if (!agentID) throw new Error("V2 native permission agent is unknown.");
    const agent = await v2Request("family permission agent", (signal) =>
      owner.lease.process.client.agent.get(
        { agentID, location: { directory: owner.native.location.directory } },
        { signal },
      ),
    );
    if (agent.location.directory !== owner.native.location.directory || agent.data.id !== agentID)
      throw new Error("V2 native agent policy source mismatch.");
    entry.assertCurrent();
    owner.family!.assertSpawn(request.generation);
    return {
      effect: v2ChildPermissionCeiling({
        ...permission,
        parent: owner.toolPolicy ?? [],
        agent: agent.data.permissions,
        overlay: native.permissions ?? [],
      }),
    };
  }
  const inputId = request.payload.inputId;
  if (typeof inputId !== "string" || !inputId)
    throw new Error("V2 native input receipt is missing.");
  if (request.kind === "context" && request.payload.nativeCompletion === true) {
    const receipt = await owner.familyControl?.nativeReceipt?.(inputId);
    if (!receipt || receipt.consumed || receipt.parentID !== request.sessionId)
      throw new Error("V2 native synthetic admission has no exact trusted receipt.");
    await owner.family!.nativeCompletion(receipt.childID, inputId);
  } else if (!child) {
    if (
      owner.family!.admission?.id !== inputId ||
      request.payload.fingerprint !== owner.family!.admission.fingerprint
    )
      throw new Error("V2 native root input is not the exact current journal admission.");
  } else if (request.kind === "prompt")
    await owner.family!.recordChildAdmission(child.id, inputId, request.generation);
  else if (child.admissionId !== inputId)
    throw new Error("V2 native child context has no exact current prompt receipt.");
  runtime.scheduleRepair(owner, false);
  return { active: true };
}

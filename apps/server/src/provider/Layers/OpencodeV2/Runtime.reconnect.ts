import { Effect } from "effect";
import { isDeepStrictEqual } from "node:util";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { decodeV2NativeSession } from "./Runtime.session.decode.ts";
import { decodeV2Cursor } from "./Runtime.cursor.ts";
import { readV2Messages } from "./Runtime.projection.ts";
import { recoverV2Session } from "./Runtime.start.ts";
import { awaitV2RuntimeReady } from "./Runtime.activation.ts";
import { registerV2RuntimeOwner } from "./Runtime.registration.owner.ts";
import { observeV2ProcessLifecycle } from "./Runtime.lifecycle.ts";
import { suspendV2BorrowedOwner } from "./Runtime.transport.ts";
import { attachV2OwnedFamily } from "./Runtime.family.ts";
import { isV2AssistantSettled } from "./Projection.ts";
import { isV2CancelledReservation } from "./Admission.cancelled.ts";
import { assertV2Model } from "./Runtime.sessions.ts";

/** Read retained identity/history before swapping transport; this path never creates or prompts. */
export async function reconnectV2BorrowedOwner(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  signal: AbortSignal,
  assertGeneration: () => void,
) {
  const revision = owner.transportRevision;
  const validate = () => {
    signal.throwIfAborted();
    assertGeneration();
    if (
      owner.stopped ||
      runtime.sessions.get(owner.threadId) !== owner ||
      owner.transportRevision !== revision
    )
      throw new Error("V2 reconnect owner changed; retained history remains blocked.");
  };
  validate();
  if (!owner.transportDetached && !owner.transportRecovering) return;
  runtime.options.threadBridge?.suspend?.(owner);
  if (owner.transportDetached) {
    const connection = runtime.options.config.sharedService;
    if (
      !connection ||
      connection.registrationFile !== owner.sharedTransport ||
      connection.storageIdentity !== owner.storageIdentity
    )
      throw new Error("V2 reconnect storage/transport mismatch; no history replacement.");
    const bindings = runtime.options.sharedBindings;
    if (!bindings) throw new Error("V2 reconnect requires retained shared binding evidence.");
    const binding = await Effect.runPromise(bindings.find(owner.threadId));
    const cursor = decodeV2Cursor(owner.session.resumeCursor);
    if (
      !binding ||
      binding.state !== "verified" ||
      binding.nativeSessionId !== owner.native.id ||
      binding.storageIdentity !== owner.storageIdentity ||
      binding.directory !== owner.native.location.directory ||
      binding.runtimeTargetId !== (owner.session.providerRuntimeExecutionTargetId ?? "local") ||
      binding.workspaceTargetId !== (owner.session.workspaceExecutionTargetId ?? "local") ||
      cursor.nativeSessionId !== binding.nativeSessionId ||
      cursor.storageIdentity !== binding.storageIdentity ||
      cursor.directory !== binding.directory ||
      (cursor.connectionMode !== undefined && cursor.connectionMode !== "shared") ||
      (cursor.registrationFamily ?? "legacy") !== (binding.registrationFamily ?? "legacy") ||
      !isDeepStrictEqual(cursor.model, owner.model) ||
      cursor.profileIssuer !== binding.profileIssuer ||
      (binding.profileIssuer !== undefined &&
        binding.profileIssuer !== owner.native.metadata?.bigbud_issuer)
    )
      throw new Error("V2 retained binding/cursor/issuer mismatch; no history replacement.");
    validate();
    const lease = await runtime.options.manager.acquire(runtime.options.config);
    let published = false;
    try {
      const native = decodeV2NativeSession(
        await v2Request(
          "reconnect session.get",
          (abort) =>
            lease.process.client.session.get({ sessionID: owner.native.id }, { signal: abort }),
          { signal },
        ),
      );
      validate();
      assertV2Model(native.model, owner.model);
      if (
        native.id !== owner.native.id ||
        native.location.directory !== binding.directory ||
        native.projectID !== owner.native.projectID ||
        native.time.created !== owner.native.time.created ||
        native.parentID ||
        native.fork ||
        !isDeepStrictEqual(native.metadata, owner.native.metadata) ||
        !isDeepStrictEqual(native.permissions, owner.toolPolicy)
      )
        throw new Error(
          "V2 retained native history identity/policy mismatch; no history replacement.",
        );
      const messages = await readV2Messages({ ...owner, lease }, signal);
      validate();
      if (
        owner.row &&
        (owner.row.state === "accepted" || owner.row.state === "terminal") &&
        !isV2CancelledReservation(owner.row) &&
        !messages.some(
          (message) =>
            message.type === "user" &&
            message.id === owner.row!.nativeAdmissionId &&
            message.metadata?.bigbud_fingerprint === owner.row!.fingerprint,
        )
      )
        throw new Error("V2 retained native admission correlation missing; no replay.");
      for (const previous of owner.messages.values()) {
        const next = messages.find((message) => message.id === previous.id);
        if (
          !next ||
          (previous.type === "assistant" &&
            isV2AssistantSettled(previous) &&
            !isDeepStrictEqual(previous, next))
        )
          throw new Error("V2 retained native message history missing or conflicting; no replay.");
      }
      const permit = runtime.options.consent?.capture();
      permit?.assertCurrent();
      validate();
      const old = owner.lease;
      owner.consentPermit?.release();
      owner.consentPermit = permit;
      owner.lease = lease;
      owner.transportDetached = false;
      owner.unsubscribeDeath = observeV2ProcessLifecycle(lease.process, () =>
        suspendV2BorrowedOwner(owner),
      );
      owner.unregister = registerV2RuntimeOwner(runtime, owner, (run) => {
        const pending = owner.operation.then(run, run);
        owner.operation = pending.catch(() => {});
        return pending;
      });
      published = true;
      await old.release();
    } finally {
      if (!published) await lease.release();
    }
  }
  validate();
  // Repair accepted/uncertain admissions from authoritative reads, including terminal delivery.
  // Retain old reservations until their existing physical settlement logic can discharge them.
  if (owner.row) {
    const retained = await Effect.runPromise(runtime.options.journal.find(owner.row));
    validate();
    if (
      !retained ||
      retained.fingerprint !== owner.row.fingerprint ||
      retained.nativeAdmissionId !== owner.row.nativeAdmissionId ||
      !isDeepStrictEqual(retained.binding, owner.row.binding)
    )
      throw new Error("V2 retained admission evidence changed or is missing; no replay.");
  }
  await recoverV2Session(runtime, owner);
  validate();
  const readiness = () =>
    awaitV2RuntimeReady(
      runtime.options,
      owner.lease.process.client,
      owner.native.location.directory,
      signal,
      !owner.localTools,
      {
        threadId: owner.threadId,
        nativeSessionId: owner.native.id,
        storageIdentity: owner.storageIdentity,
        directory: owner.native.location.directory,
        registrationFamily:
          owner.native.metadata?.bigbud_registration === "scoped" ? "scoped" : "legacy",
      },
    );
  if (owner.row && owner.row.state !== "terminal" && owner.row.state !== "reserved") {
    if (owner.row.state === "accepted" && owner.session.status !== "error" && !owner.family?.live) {
      await readiness();
      validate();
      // Explicit replies may finish the exact accepted native admission. New turns and old
      // canonical callbacks stay fenced by transportRecovering until physical retirement.
      owner.executionBlocked = undefined;
    }
    return;
  }
  if (owner.family?.persistenceUncertain) return;
  if (owner.activation?.token || owner.family?.live || owner.coding?.busyCount?.()) return;
  const active = await v2Request(
    "reconnect session.active",
    (abort) => owner.lease.process.client.session.active({ signal: abort }),
    { signal },
  );
  const inbox = await v2Request(
    "reconnect session.inbox",
    (abort) =>
      owner.lease.process.client.session.inbox.list(
        { sessionID: owner.native.id },
        { signal: abort },
      ),
    { signal },
  );
  validate();
  if (active[owner.native.id] || inbox.length) return;
  const ready = await readiness();
  validate();
  if (ready) owner.activation = { ...ready, phase: "settled" };
  // Old callback authorities stay fenced until fresh canonical and family readiness succeeds.
  owner.executionBlocked = undefined;
  try {
    await runtime.options.threadBridge?.reconnect?.(owner, runtime);
    validate();
    const requiresFamily = Boolean(
      owner.detachSubagentGuard ||
      owner.familyQualification ||
      owner.toolPolicy?.some((rule) => rule.action === "subagent" && rule.effect !== "deny"),
    );
    owner.detachFamilyTransport?.();
    owner.detachSubagentGuard = undefined;
    delete owner.familyControl;
    delete owner.familyPhysicalDrain;
    await attachV2OwnedFamily(runtime, owner);
    validate();
    if (requiresFamily && !owner.familyQualification)
      throw new Error("V2 native family qualification changed; existing policy remains blocked.");
    owner.transportRecovering = false;
    owner.session = {
      ...owner.session,
      status: "ready",
      lastError: undefined,
      activeTurnId: undefined,
    };
  } catch (error) {
    owner.executionBlocked =
      "V2 generation readiness remains unconfirmed; no new execution or resend.";
    throw error;
  }
}

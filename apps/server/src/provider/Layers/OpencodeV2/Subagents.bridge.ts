import { randomBytes, timingSafeEqual } from "node:crypto";
import { Effect, Schema } from "effect";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { V2SubagentQualification } from "./Runtime.family.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";
import type { NativeFamilyQualification } from "./Subagents.qualification.ts";
import { openV2ThreadTransport } from "./Orchestration.transport.ts";
import { openV2ThreadEncryptedRequest } from "./Orchestration.crypto.ts";
import {
  NativeFamilyCallback,
  nativeFamilyResponse,
  NativeFamilyRegistration,
} from "./Subagents.protocol.ts";
import type { V2NativeFamilyArtifact } from "./Subagents.artifact.ts";
import { verifyV2NativeFamilySource } from "./Subagents.readiness.ts";
import { callV2NativeFamily } from "./Subagents.rpc.ts";
import { handleV2NativeFamilyCallback } from "./Subagents.callback.ts";
import { assertV2SharedSessionOwner } from "./Runtime.ownership.ts";
import { hasV2UnconfirmedFamily } from "./Runtime.family.loss.ts";
import { v2Request } from "./Client.ts";
import { decodeV2NativeFamilyState } from "./Subagents.state.ts";
import { decodeV2FamilyReceipt, V2_FAMILY_ABI } from "./Subagents.extension.ts";
import { currentV2RequestContext, runV2RequestContext } from "./Client.guard.ts";
import { makeV2NativeFamilyDrain } from "./Subagents.bridge.drain.ts";

type Entry = Parameters<typeof handleV2NativeFamilyCallback>[0] & {
  active: number;
  activeSessions: Map<string, number>;
  timer: ReturnType<typeof setInterval>;
};
/** One encrypted callback listener per app broker; no child subprocess/socket/SSE subscription. */
export class V2NativeFamilyBridge {
  private readonly owners = new Map<string, Entry>();
  private constructor(
    readonly artifact: V2NativeFamilyArtifact,
    private readonly transport: Awaited<ReturnType<typeof openV2ThreadTransport>>,
  ) {}
  static async open(artifact: V2NativeFamilyArtifact) {
    let bridge: V2NativeFamilyBridge | undefined;
    const transport = await openV2ThreadTransport(async (body, signal) => {
      if (!bridge) throw new Error("V2 native family broker unavailable.");
      const encrypted = openV2ThreadEncryptedRequest(body, artifact.encryptionPrivateKey);
      const request = Schema.decodeUnknownSync(NativeFamilyCallback)(encrypted.payload, {
        onExcessProperty: "error",
      });
      const entry = bridge.owners.get(request.rootId);
      if (
        !entry ||
        !timingSafeEqual(
          Buffer.from(encrypted.token),
          Buffer.from(entry.registration.callbackToken),
        )
      )
        throw new Error("V2 native family callback token/owner rejected.");
      entry.active++;
      if (request.kind !== "probe") entry.owner.familyPhysicalDrain?.invalidate();
      entry.activeSessions.set(
        request.sessionId,
        (entry.activeSessions.get(request.sessionId) ?? 0) + 1,
      );
      try {
        const result = await entry.runtime.authorized(async () => {
          const validate = () => {
            signal.throwIfAborted();
            entry.assertCurrent();
            if (request.kind !== "probe") entry.owner.family!.assertSpawn(request.generation);
          };
          validate();
          const context = currentV2RequestContext();
          return context
            ? runV2RequestContext(
                { ...context, operationSignal: signal, operationGuard: validate },
                () => handleV2NativeFamilyCallback(entry, request),
              )
            : handleV2NativeFamilyCallback(entry, request);
        });
        signal.throwIfAborted();
        return encrypted.seal(nativeFamilyResponse(artifact.privateKey, request, result));
      } finally {
        entry.active--;
        const remaining = (entry.activeSessions.get(request.sessionId) ?? 1) - 1;
        if (remaining) entry.activeSessions.set(request.sessionId, remaining);
        else entry.activeSessions.delete(request.sessionId);
      }
    });
    bridge = new V2NativeFamilyBridge(artifact, transport);
    return bridge;
  }
  qualification(
    owner: V2RuntimeSession,
    runtime: OpencodeV2Runtime,
    proof: V2NativeRuntimeProof,
    record: NativeFamilyQualification,
    verifyCanonical: () => Promise<void>,
  ): V2SubagentQualification {
    const epoch = owner.epoch,
      process = owner.lease.generation,
      transportGeneration =
        runtime.options.config.sharedService?.generation ?? String(owner.lease.generation);
    const assertCurrent = () => {
      proof.assertCurrent();
      owner.consentPermit?.assertCurrent();
      if (
        proof.nativeVersion !== record.nativeVersion ||
        proof.directory !== owner.native.location.directory ||
        runtime.sessions.get(owner.threadId) !== owner ||
        owner.stopped ||
        owner.epoch !== epoch ||
        owner.lease.generation !== process ||
        !owner.lease.process.isRunning()
      )
        throw new Error("V2 native family owner/qualification changed.");
    };
    const refresh = async () => {
      assertCurrent();
      await verifyCanonical();
      await verifyV2NativeFamilySource(this.artifact, owner.lease.process.client, proof);
      assertCurrent();
    };
    return {
      assertCurrent,
      attach: async (_owner, beforePrompt, beforeSpawn) => {
        if (
          _owner !== owner ||
          !owner.family ||
          this.owners.has(owner.native.id) ||
          this.owners.size >= 32
        )
          throw new Error("V2 native family root registration conflict/capacity.");
        const drain = makeV2NativeFamilyDrain(owner);
        owner.familyPhysicalDrain = drain.authority;
        await refresh();
        const registration = Schema.decodeUnknownSync(NativeFamilyRegistration)({
          rootId: owner.native.id,
          storageIdentity: owner.storageIdentity,
          threadId: owner.threadId,
          directory: owner.native.location.directory,
          epoch,
          transportGeneration,
          nonce: randomBytes(16).toString("hex"),
          callbackToken: randomBytes(32).toString("hex"),
          callbackUrl: this.transport.url,
          generation: owner.family.generation,
          expires: Date.now() + 60000,
        });
        const timer = setInterval(() => {
          if (owner.family!.isFenced) return;
          void runtime
            .authorized(async () => {
              await refresh();
              Object.assign(registration, {
                expires: Date.now() + 60000,
                generation: owner.family!.generation,
              });
              await callV2NativeFamily(
                owner,
                this.artifact,
                "enroll",
                { ...registration },
                registration.nonce,
              );
            })
            .catch(() => {});
        }, 20000);
        timer.unref();
        const entry: Entry = {
          owner,
          runtime,
          registration,
          assertCurrent,
          refresh,
          beforePrompt,
          beforeSpawn,
          seen: new Map(),
          active: 0,
          activeSessions: new Map(),
          timer,
        };
        this.owners.set(owner.native.id, entry);
        const call = (
          method: "enroll" | "authorize" | "fence" | "inspect" | "receipt",
          body: Record<string, unknown>,
        ) => callV2NativeFamily(owner, this.artifact, method, body, registration.nonce);
        try {
          const source = await verifyV2NativeFamilySource(
            this.artifact,
            owner.lease.process.client,
            proof,
          );
          const info = source.decodeInfo(
            await callV2NativeFamily(owner, this.artifact, "info", {}, registration.nonce),
          );
          const extension = record.syntheticAdmission === V2_FAMILY_ABI;
          if (info.familyABI && !extension)
            throw new Error(
              "V2 custom native family runtime requires extension-specific qualification.",
            );
          if (
            extension &&
            (info.familyABI !== V2_FAMILY_ABI ||
              info.familySourceDigest !== record.nativeFamilySourceDigest)
          )
            throw new Error("V2 native family ABI/source capability mismatch.");
          let nativePending = 0;
          let nativePendingBySession: Readonly<Record<string, number>> = {};
          const enrolled = decodeV2NativeFamilyState(
            await call("enroll", { ...registration }),
            owner,
            registration.nonce,
          );
          if (enrolled.stopped && !owner.family.isFenced) await owner.family.fence();
          owner.familyControl = {
            ...(extension
              ? {
                  nativeReceipt: async (inputID: string) =>
                    decodeV2FamilyReceipt(
                      await call("receipt", {
                        rootId: owner.native.id,
                        nonce: registration.nonce,
                        inputID,
                      }),
                      owner,
                      this.artifact.rpcID,
                      inputID,
                    ),
                  confirmCancellation: () => owner.familyControl!.fence(),
                  refreshNative: async () => {
                    try {
                      const state = decodeV2NativeFamilyState(
                        await call("inspect", {
                          rootId: owner.native.id,
                          nonce: registration.nonce,
                        }),
                        owner,
                        registration.nonce,
                      );
                      const evidence = state.nativeFamily;
                      if (
                        !evidence ||
                        evidence.rootID !== owner.native.id ||
                        evidence.ownerID !== this.artifact.rpcID ||
                        evidence.generation !== owner.family!.generation ||
                        evidence.uncertain
                      )
                        throw new Error("V2 native family closure query is uncertain.");
                      nativePending = evidence.pending;
                      if (!evidence.pendingBySession)
                        throw new Error("V2 native per-session closure is unavailable.");
                      nativePendingBySession = evidence.pendingBySession;
                    } catch (error) {
                      nativePending = Math.max(1, nativePending);
                      throw error;
                    }
                  },
                }
              : {}),
            busyCount: () => entry.active + nativePending,
            childBusyCount: (id) =>
              (entry.activeSessions.get(id) ?? 0) + (nativePendingBySession[id] ?? 0),
            fence: async () => {
              await drain.fence(
                () => call("fence", { rootId: owner.native.id, nonce: registration.nonce }),
                registration.nonce,
                this.artifact.rpcID,
                extension,
              );
              if (extension && drain.authority.confirmed()) {
                nativePending = 0;
                nativePendingBySession = {};
              }
            },
            authorizeInput: async (row) => {
              drain.authority.invalidate();
              await refresh();
              if (
                row.binding.nativeSessionId !== owner.native.id ||
                row.binding.storageIdentity !== owner.storageIdentity ||
                row.state !== "reserved"
              )
                throw new Error("V2 rearming requires this root's immutable reservation.");
              await assertV2SharedSessionOwner(owner);
              if (owner.family!.isFenced) {
                const active = await v2Request("family rearm native drain", (signal) =>
                  owner.lease.process.client.session.active({ signal }),
                );
                const inbox = await v2Request("family rearm input drain", (signal) =>
                  owner.lease.process.client.session.inbox.list(
                    { sessionID: owner.native.id },
                    { signal },
                  ),
                );
                if (active[owner.native.id] || inbox.length || owner.family!.live)
                  throw new Error("V2 prior generation remains live/queued; rearming rejected.");
              }
              assertCurrent();
              await owner.family!.authorizeAdmission(row.nativeAdmissionId, row.fingerprint);
              const generation = owner.family!.generation;
              const state = decodeV2NativeFamilyState(
                await call("authorize", {
                  rootId: owner.native.id,
                  nonce: registration.nonce,
                  generation,
                  inputId: row.nativeAdmissionId,
                  fingerprint: row.fingerprint,
                  leaseExpires: Date.now() + 60000,
                }),
                owner,
                registration.nonce,
              );
              if (state.fenced || state.stopped || state.inputId !== row.nativeAdmissionId)
                throw new Error("V2 native input authorization is unconfirmed.");
              assertCurrent();
              owner.family!.assertSpawn(generation);
            },
          };
          const retained = await Effect.runPromise(
            runtime.options.journal.latestBound(owner.threadId),
          );
          if (
            retained?.state === "accepted" &&
            !owner.family.isFenced &&
            owner.family.admission?.id === retained.nativeAdmissionId
          ) {
            drain.authority.invalidate();
            await call("authorize", {
              rootId: owner.native.id,
              nonce: registration.nonce,
              generation: owner.family.generation,
              inputId: retained.nativeAdmissionId,
              fingerprint: retained.fingerprint,
              leaseExpires: Date.now() + 60000,
            });
          }
          return async () => {
            if (hasV2UnconfirmedFamily(owner))
              throw new Error(
                "V2 family disposal requires physical drain; native server exit is insufficient.",
              );
            if (owner.lease.process.hasExited?.() !== true) {
              const state = decodeV2NativeFamilyState(
                await call("inspect", { rootId: owner.native.id, nonce: registration.nonce }),
                owner,
                registration.nonce,
              );
              if (
                !state.fenced ||
                !state.stopped ||
                entry.active ||
                owner.family!.live ||
                owner.family!.persistenceUncertain
              )
                throw new Error("V2 native family disposal requires confirmed family retirement.");
            }
            clearInterval(timer);
            if (this.owners.get(owner.native.id) === entry) this.owners.delete(owner.native.id);
          };
        } catch (error) {
          clearInterval(timer);
          this.owners.delete(owner.native.id);
          throw error;
        }
      },
    };
  }
  async close() {
    for (const entry of this.owners.values()) clearInterval(entry.timer);
    this.owners.clear();
    await this.transport.close();
  }
}

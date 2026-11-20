import { makeRelayCallerScopes } from "./clientRelay.callers.ts";
import { makeRelayOperationNonces } from "./clientRelay.nonces.ts";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import {
  RemoteBackendRelayError,
  type RemoteBackendRelayLease,
} from "@bigbud/contracts/server/remoteBackendRelay.ts";
import type {
  RemoteBackendRelayProfileDirectory,
  ResolvedRemoteBackendRelayProfile,
} from "./clientRelay.profiles.ts";
import type { RemoteBackendRelayOwnedEndpoint } from "./clientRelay.profileOwner.ts";

interface Entry {
  readonly callerId: string;
  readonly profileId: string;
  readonly requestId: string;
  readonly controller: AbortController;
  opening: Promise<RemoteBackendRelayLease>;
  owner?: RemoteBackendRelayOwnedEndpoint;
  closing?: Promise<void>;
}
const refused = (code: RemoteBackendRelayError["code"], message: string) =>
  new RemoteBackendRelayError({ code, message });

/** Ephemeral transport leases only. No new authority/runtime/installation database. */
export function makeRemoteBackendRelayLeases(input: {
  readonly profiles: RemoteBackendRelayProfileDirectory;
  readonly isCallerActive: (callerId: string) => Promise<boolean>;
  readonly openProfile: (
    profile: ResolvedRemoteBackendRelayProfile,
    signal: AbortSignal,
  ) => Promise<RemoteBackendRelayOwnedEndpoint>;
  readonly maxLeases?: number;
  readonly maxCallerLeases?: number;
  readonly maxCallerHistory?: number;
}) {
  const maxLeases = input.maxLeases ?? 32;
  const maxCallerLeases = input.maxCallerLeases ?? 4;
  if (
    !Number.isInteger(maxLeases) ||
    maxLeases < 1 ||
    maxLeases > 32 ||
    !Number.isInteger(maxCallerLeases) ||
    maxCallerLeases < 1 ||
    maxCallerLeases > 4
  )
    throw new Error("Invalid bounded backend relay lease limits.");
  const entries = new Map<string, Entry>();
  const nonces = makeRelayOperationNonces<Entry>(input.maxCallerHistory);
  const callers = makeRelayCallerScopes(input.isCallerActive);
  const active = callers.assertActive;
  const closeEntry = (leaseId: string, entry: Entry): Promise<void> => {
    if (entry.closing) return entry.closing;
    const operation = nonces.get(entry.callerId, entry.requestId);
    if (operation) operation.cancelled = true;
    entry.controller.abort();
    return (entry.closing = (async () => {
      await entry.opening.catch(() => {});
      await entry.owner?.dispose();
      if (entries.get(leaseId) === entry) entries.delete(leaseId);
      if (operation) operation.value = undefined;
    })());
  };
  const settle = async (selected: ReadonlyArray<readonly [string, Entry]>) => {
    for (const [, entry] of selected) entry.controller.abort();
    const results = await Promise.allSettled(selected.map(([id, entry]) => closeEntry(id, entry)));
    if (results.some((result) => result.status === "rejected"))
      throw refused("unavailable", "Backend relay cleanup failed.");
  };
  return {
    list(callerId: string, external: AbortSignal) {
      return callers.run(callerId, external, async (signal) => {
        signal.throwIfAborted();
        const result = await input.profiles.list(callerId, signal);
        await active(callerId);
        signal.throwIfAborted();
        if (result.profiles.length > 64)
          throw refused("limit", "Too many approved backend profiles.");
        // Explicit public projection: never serialize deployment, executables or upstream credentials.
        return {
          availability: result.availability,
          profiles: result.profiles.map((profile) => ({
            profileId: profile.profileId,
            label: profile.label,
            identity: {
              authority: {
                authorityId: profile.identity.authority.authorityId,
                keyEpoch: profile.identity.authority.keyEpoch,
                keyFingerprint: profile.identity.authority.keyFingerprint,
              },
              installationFingerprint: profile.identity.installationFingerprint,
            },
          })),
        };
      });
    },
    open(
      callerId: string,
      profileId: string,
      external: AbortSignal,
      requestId: string = randomUUID(),
    ): Promise<RemoteBackendRelayLease> {
      return callers.run(callerId, external, async (signal) => {
        signal.throwIfAborted();
        const previous = nonces.get(callerId, requestId);
        if (previous) {
          if (previous.profileId !== undefined && previous.profileId !== profileId)
            throw refused(
              "conflict",
              "A relay request nonce cannot select a different backend profile.",
            );
          if (previous.cancelled || !previous.value)
            throw refused("caller-closed", "This relay request was already canceled or closed.");
          return previous.value.opening;
        }
        const callerCount = [...entries.values()].filter(
          (entry) => entry.callerId === callerId,
        ).length;
        if (entries.size >= maxLeases || callerCount >= maxCallerLeases)
          throw refused("limit", "Backend relay lease limit reached.");
        const operation = nonces.reserve(callerId, requestId, profileId);
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) controller.abort(signal.reason);
        const leaseId = randomUUID();
        const entry: Entry = {
          callerId,
          profileId,
          requestId,
          controller,
          opening: Promise.resolve()
            .then(async () => {
              controller.signal.throwIfAborted();
              const profile = await input.profiles.resolve(profileId, callerId, controller.signal);
              controller.signal.throwIfAborted();
              await active(callerId);
              controller.signal.throwIfAborted();
              if (profile.profile.profileId !== profileId)
                throw refused("unavailable", "Approved backend profile does not match selection.");
              entry.owner = await input.openProfile(profile, controller.signal);
              controller.signal.throwIfAborted();
              await active(callerId);
              controller.signal.throwIfAborted();
              return {
                leaseId,
                profileId,
                baseUrl: entry.owner.baseUrl,
                localCredential: entry.owner.localCredential,
              };
            })
            .catch(async (error: unknown) => {
              operation.cancelled = true;
              await entry.owner?.dispose();
              operation.value = undefined;
              if (entries.get(leaseId) === entry) entries.delete(leaseId);
              if (Schema.is(RemoteBackendRelayError)(error)) throw error;
              if (controller.signal.aborted)
                throw refused("caller-closed", "Backend relay opening was canceled.");
              throw refused("unavailable", "The approved backend relay is unavailable.");
            })
            .finally(() => signal.removeEventListener("abort", abort)),
        };
        operation.value = entry;
        entries.set(leaseId, entry);
        return entry.opening;
      });
    },
    close(callerId: string, leaseId: string) {
      return callers.run(callerId, new AbortController().signal, async () => {
        const entry = entries.get(leaseId);
        if (!entry || entry.callerId !== callerId) return { closed: false };
        await closeEntry(leaseId, entry);
        return { closed: true };
      });
    },
    cancel(callerId: string, requestId: string) {
      return callers.run(callerId, new AbortController().signal, async () => {
        const operation = nonces.cancel(callerId, requestId);
        const entry = operation.value;
        if (entry) {
          const selected = [...entries].find(([, candidate]) => candidate === entry);
          if (selected) await closeEntry(selected[0], entry);
        }
        return { closed: true };
      });
    },
    async closeCaller(callerId: string) {
      const pending = callers.closeCaller(callerId);
      nonces.cancelCaller(callerId);
      const owned = [...entries].filter(([, entry]) => entry.callerId === callerId);
      await settle(owned);
      await pending;
      nonces.forgetCaller(callerId);
    },
    async closeProfile(profileId: string) {
      const selected = [...entries].filter(([, entry]) => entry.profileId === profileId);
      await settle(selected);
    },
    async dispose() {
      const pending = callers.closeAll();
      await settle([...entries]);
      await pending;
      nonces.clear();
    },
  };
}
export type RemoteBackendRelayLeases = ReturnType<typeof makeRemoteBackendRelayLeases>;

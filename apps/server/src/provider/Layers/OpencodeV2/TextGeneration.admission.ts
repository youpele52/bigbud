import type { V2SharedConnection } from "./SharedService.descriptor.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { retainedV2TextGenerationSessions } from "./TextGeneration.inventory.ts";

interface Job {
  owner: { scope?: string } | undefined;
  readonly observed: Set<string>;
}

/** Without physical-storage independence proof, all observed jobs conservatively share one budget.
 * Inventories coalesce only while in flight for an exact verified descriptor; never reuse A's view for B. */
export function makeV2TextGenerationAdmission(maximum: number) {
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error("Invalid V2 auxiliary capacity.");
  const jobs = new Map<string, Job>();
  const inventories = new Map<string, Promise<ReadonlyArray<string>>>();
  const settledDuringInventory = new Map<string, Set<string>>();
  let readers = 0;
  return {
    reserve(id: string) {
      if (jobs.size >= maximum)
        throw new Error("V2 auxiliary generation capacity reached; uncertain work is retained.");
      if (jobs.has(id)) throw new Error("V2 auxiliary reservation identity already exists.");
      const owner: { scope?: string } = {};
      const job: Job = { owner, observed: new Set() };
      jobs.set(id, job);
      return {
        release: (settledNative = false) => {
          if (job.owner !== owner) return;
          // Settlement proves only this exact original connection, not another namespace's copy.
          if (settledNative && owner.scope) {
            job.observed.delete(owner.scope);
            if (readers > 0) {
              const scopes = settledDuringInventory.get(id) ?? new Set<string>();
              scopes.add(owner.scope);
              settledDuringInventory.set(id, scopes);
            }
          }
          job.owner = undefined;
          if (job.observed.size === 0) jobs.delete(id);
        },
      };
    },
    async reconcile(
      connection: {
        client: OpencodeV2Client;
        storageIdentity: string;
        descriptor: V2SharedConnection;
      },
      signal: AbortSignal,
      ownerId: string,
    ) {
      const descriptor = connection.descriptor;
      if (
        !descriptor?.registrationFile ||
        !descriptor.generation ||
        !descriptor.storageIdentity ||
        descriptor.storageIdentity !== connection.storageIdentity
      )
        throw new Error("V2 auxiliary connection provenance is unavailable; no native dispatch.");
      const key = JSON.stringify([
        descriptor.registrationFile,
        descriptor.storageIdentity,
        descriptor.generation,
      ]);
      const owner = jobs.get(ownerId)?.owner;
      if (!owner || (owner.scope && owner.scope !== key))
        throw new Error("V2 auxiliary reservation owner/connection changed.");
      owner.scope = key;
      let pending = inventories.get(key);
      if (!pending) {
        pending = retainedV2TextGenerationSessions(connection.client, signal);
        inventories.set(key, pending);
      }
      readers++;
      try {
        for (const id of await pending) {
          if (settledDuringInventory.get(id)?.has(key)) continue;
          const job = jobs.get(id) ?? { owner: undefined, observed: new Set<string>() };
          if (job.observed.size >= 32 && !job.observed.has(key))
            throw new Error("V2 auxiliary connection-observation bound reached; history retained.");
          job.observed.add(key);
          jobs.set(id, job);
          if (jobs.size > maximum)
            throw new Error("V2 auxiliary generation capacity retained by unresolved native work.");
        }
        if (jobs.size > maximum)
          throw new Error("V2 auxiliary generation capacity retained by unresolved native work.");
      } finally {
        if (inventories.get(key) === pending) inventories.delete(key);
        if (--readers === 0) settledDuringInventory.clear();
      }
    },
    occupied: () => jobs.size,
  };
}

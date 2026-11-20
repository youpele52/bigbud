import { join } from "node:path";
import {
  MAX_REMOTE_AGENT_REGISTRY_BYTES,
  parseRemoteAgentRegistry,
} from "../remote-agent/remoteAgentInstall.registry.ts";
import { readLocalSupervisorServiceFile } from "./localSupervisorService.files.ts";

/** Lock-free fresh durable reread shared by batched admissions; never a CAS or write permit. */
export async function readMobileGatewayAdmissionRegistry(controlRoot: string) {
  const text = await readLocalSupervisorServiceFile(
    join(controlRoot, "control-v1", "registry.json"),
    MAX_REMOTE_AGENT_REGISTRY_BYTES,
  );
  return parseRemoteAgentRegistry(text);
}

/**
 * Single-flight admission reads. Callers that arrive before a batch seals share its one fresh
 * read; callers that arrive after it sealed share exactly one queued successor batch. A caller's
 * own abort settles only its waiter, never the shared read other admissions depend on.
 */
export function mobileGatewayAdmissionBatch<T>(input: {
  /** Synchronous liveness fence checked before a caller may join any batch. */
  readonly assertLive: () => void;
  /** One fresh read. It runs after its batch sealed, so every member arrived before its IO. */
  readonly work: () => Promise<T>;
}) {
  interface Batch {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (cause: unknown) => void;
    sealed: boolean;
  }
  let active: Batch | undefined, queued: Batch | undefined;
  const accepted = new Set<Promise<T>>();
  const createBatch = (): Batch => {
    let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    accepted.add(promise);
    void promise.catch(() => {});
    return { promise, resolve, reject, sealed: false };
  };
  const runBatch = (batch: Batch): void => {
    void Promise.resolve()
      .then(async () => {
        batch.sealed = true; // Every member arrived before this batch's fresh async guards/read.
        return input.work();
      })
      .then(batch.resolve, batch.reject)
      .finally(() => {
        accepted.delete(batch.promise);
        if (active === batch) active = undefined;
        if (queued) {
          const next = queued;
          queued = undefined;
          active = next;
          runBatch(next);
        }
      });
  };
  const read = (external?: AbortSignal): Promise<T> => {
    try {
      external?.throwIfAborted();
      input.assertLive();
    } catch (cause) {
      return Promise.reject(cause);
    }
    let batch: Batch;
    if (!active) {
      batch = createBatch();
      active = batch;
      runBatch(batch);
    } else if (!active.sealed) batch = active;
    else {
      queued ??= createBatch();
      batch = queued;
    }
    const shared = batch.promise;
    if (!external) return shared;
    const waiter = new Promise<T>((resolve, reject) => {
      const abort = () => reject(external.reason);
      external.addEventListener("abort", abort, { once: true });
      void shared.then(
        (value) => {
          external.removeEventListener("abort", abort);
          if (external.aborted) reject(external.reason);
          else resolve(value);
        },
        (cause) => {
          external.removeEventListener("abort", abort);
          reject(cause);
        },
      );
      if (external.aborted) abort();
    });
    void waiter.catch(() => {});
    return waiter;
  };
  return Object.freeze({
    read,
    /** Waits for every accepted batch, including one queued behind the active read. */
    settle: async () => {
      await Promise.allSettled(accepted);
    },
  });
}

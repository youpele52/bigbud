import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { requireCurrentMobilePublicationStage } from "./mobileOptionalPublication.journal.ts";
import {
  assertMobilePublicationAuthority,
  assertMobilePublicationLease,
  retireMobilePublicationAuthority,
  releaseMobilePublicationAuthority,
  type MobilePublicationAuthority,
} from "./mobileOptionalPublication.authority.ts";

// Conservative reservation for one component job, not an RSS measurement; caller inputs are separate.
export class MobilePublicationWorkBusy extends Error {
  readonly _tag = "MobilePublicationWorkBusy";
  constructor() {
    super("Mobile publication work budget is temporarily occupied.");
  }
}
export const MOBILE_PUBLICATION_IO_RESERVATION = 512 * 1024 * 1024;
type OwnedReader = <A>(
  operation: (signal: AbortSignal) => Promise<A>,
  signal?: AbortSignal,
) => Promise<A>;
const readers = new WeakMap<MobilePublicationAuthority, OwnedReader>();
const lifetimeJobs = new WeakMap<MobilePublicationAuthority, OwnedReader>();
const teardownReaders = new WeakMap<MobilePublicationAuthority, OwnedReader>();
export function runOwnedMobilePublicationRead<A>(
  authority: MobilePublicationAuthority,
  operation: (signal: AbortSignal) => Promise<A>,
  signal?: AbortSignal,
): Promise<A> {
  assertMobilePublicationAuthority(authority);
  const reader = readers.get(authority);
  if (!reader) throw new Error("Mobile publication read owner is unavailable.");
  return reader(operation, signal);
}

/** One owned process lifetime; it tracks settlement without occupying the byte/read permit. */
export function runOwnedMobilePublicationLifetime<A>(
  authority: MobilePublicationAuthority,
  operation: (signal: AbortSignal) => Promise<A>,
  external?: AbortSignal,
): Promise<A> {
  assertMobilePublicationAuthority(authority);
  const run = lifetimeJobs.get(authority);
  if (!run) throw new Error("Mobile publisher lifetime owner is unavailable.");
  return run(operation, external);
}

/** Teardown never grants file/execution authority; queued work remains owned after consent retirement. */
export function runOwnedMobilePublicationTeardown<A>(
  authority: MobilePublicationAuthority,
  operation: (signal: AbortSignal) => Promise<A>,
): Promise<A> {
  assertMobilePublicationLease(authority);
  const reader = teardownReaders.get(authority);
  if (!reader) throw new Error("Mobile teardown owner is unavailable.");
  return reader(operation);
}

/** Bounded owned jobs; cancellation never means their file work has already stopped. */
export function createMobilePublicationWork<A>(
  authority: MobilePublicationAuthority,
  keys: Readonly<Record<string, string>>,
  lifetime: AbortSignal,
) {
  const pending = new Map<
    string,
    { identity: string; abort: AbortController; promise: Promise<A> }
  >();
  const acceptedReads = new Map<Promise<unknown>, AbortController>();
  const acceptedLifetimes = new Map<Promise<unknown>, AbortController>();
  const acceptedTeardowns = new Set<Promise<unknown>>();
  let closing = false;
  let closed = false;
  let retainedBytes = 0;
  let activeIO = 0;
  const unsubscribe = authority.subscribe?.((snapshot) => {
    if (snapshot.settings.mobileRemoteControl.enabled) return;
    closed = true;
    for (const operation of pending.values())
      operation.abort.abort(new Error("Mobile consent settings revoked."));
    for (const abort of acceptedReads.values())
      abort.abort(new Error("Mobile consent settings revoked."));
    for (const abort of acceptedLifetimes.values())
      abort.abort(new Error("Mobile consent settings revoked."));
    retireMobilePublicationAuthority(authority);
  });
  const join = (id: string, identity: string) => {
    if (closed || lifetime.aborted) throw new Error("Mobile publisher is closing.");
    const prior = pending.get(id);
    if (prior && prior.identity !== identity)
      throw new Error("Mobile stage has another owned operation.");
    return prior?.promise;
  };
  const assertCapacity = (size: number) => {
    assertMobilePublicationAuthority(authority);
    if (closed || lifetime.aborted) throw new Error("Mobile publication is closed.");
    if (activeIO !== 0 || acceptedTeardowns.size !== 0) throw new MobilePublicationWorkBusy();
    if (pending.size >= 16 || retainedBytes + size > MOBILE_PUBLICATION_IO_RESERVATION)
      throw new Error("Mobile publication is over its work budget.");
  };
  const start = (
    id: string,
    identity: string,
    size: number,
    operation: (signal: AbortSignal, abort: AbortController) => Promise<A>,
  ) => {
    const prior = join(id, identity);
    if (prior) return prior;
    assertCapacity(size);
    retainedBytes += size;
    activeIO += 1;
    const abort = new AbortController();
    const onAbort = () => abort.abort(lifetime.reason);
    lifetime.addEventListener("abort", onAbort, { once: true });
    const promise = Promise.resolve()
      .then(() => operation(abort.signal, abort))
      .finally(() => {
        lifetime.removeEventListener("abort", onAbort);
        retainedBytes -= size;
        activeIO -= 1;
        pending.delete(id);
      });
    void promise.catch(() => {});
    pending.set(id, { identity, abort, promise });
    return promise;
  };
  const read: OwnedReader = <B>(
    operation: (signal: AbortSignal) => Promise<B>,
    external?: AbortSignal,
  ) => {
    assertCapacity(MOBILE_PUBLICATION_IO_RESERVATION);
    activeIO += 1;
    retainedBytes += MOBILE_PUBLICATION_IO_RESERVATION;
    const abort = new AbortController();
    const onLifetime = () => abort.abort(lifetime.reason);
    const onExternal = () => abort.abort(external?.reason);
    lifetime.addEventListener("abort", onLifetime, { once: true });
    external?.addEventListener("abort", onExternal, { once: true });
    if (external?.aborted) onExternal();
    const promise = Promise.resolve()
      .then(() => {
        abort.signal.throwIfAborted();
        return operation(abort.signal);
      })
      .finally(() => {
        lifetime.removeEventListener("abort", onLifetime);
        external?.removeEventListener("abort", onExternal);
        activeIO -= 1;
        retainedBytes -= MOBILE_PUBLICATION_IO_RESERVATION;
        acceptedReads.delete(promise);
      });
    acceptedReads.set(promise, abort);
    void promise.catch(() => {});
    return promise;
  };
  const processLifetime: OwnedReader = <B>(
    operation: (signal: AbortSignal) => Promise<B>,
    external?: AbortSignal,
  ) => {
    assertMobilePublicationAuthority(authority);
    if (closed || lifetime.aborted || acceptedLifetimes.size !== 0)
      throw new Error("Mobile publisher already owns a process lifetime or is closing.");
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, lifetime, ...(external ? [external] : [])]);
    const promise = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation(signal);
      })
      .finally(() => {
        acceptedLifetimes.delete(promise);
      });
    acceptedLifetimes.set(promise, abort);
    void promise.catch(() => {});
    return promise;
  };
  const teardown: OwnedReader = <B>(operation: (signal: AbortSignal) => Promise<B>) => {
    assertMobilePublicationLease(authority);
    if (closing || acceptedTeardowns.size >= 16)
      throw new Error("Mobile teardown owner is closing or at capacity.");
    const predecessors: Promise<unknown>[] = [...pending.values()].map((job) => job.promise);
    predecessors.push(...acceptedReads.keys(), ...acceptedTeardowns);
    const signal = new AbortController().signal;
    const promise = Promise.allSettled(predecessors)
      .then(async () => {
        assertMobilePublicationLease(authority);
        await authority.assertAuthority();
        const result = await operation(signal);
        await authority.assertAuthority();
        assertMobilePublicationLease(authority);
        return result;
      })
      .finally(() => {
        acceptedTeardowns.delete(promise);
      });
    acceptedTeardowns.add(promise);
    void promise.catch(() => {});
    return promise;
  };
  if (readers.has(authority))
    throw new Error("Mobile publication already has an owned work group.");
  readers.set(authority, read);
  teardownReaders.set(authority, teardown);
  lifetimeJobs.set(authority, processLifetime);
  const watch = (
    id: string,
    revision: number,
    gateway: MobileOptionalArtifact,
    abort: AbortController,
  ) => {
    let checking: Promise<void> | undefined;
    const timer = setInterval(() => {
      checking ??= authority
        .inspect(revision, gateway, keys, abort.signal, false)
        .then((current) => {
          requireCurrentMobilePublicationStage(current.state, current.context, id);
        })
        .catch((error: unknown) => {
          abort.abort(error);
        })
        .finally(() => {
          checking = undefined;
        });
    }, 1000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await checking;
    };
  };
  const close = async () => {
    closed = true;
    unsubscribe?.();
    for (const operation of pending.values())
      operation.abort.abort(new Error("Mobile publisher owner closing."));
    for (const abort of acceptedReads.values())
      abort.abort(new Error("Mobile publisher read owner closing."));
    for (const abort of acceptedLifetimes.values())
      abort.abort(new Error("Mobile publisher process owner closing."));
    // Accepted process finally blocks may still enqueue exact-child teardown while the lease holds.
    await Promise.allSettled(acceptedLifetimes.keys());
    closing = true;
    const completion: Promise<unknown>[] = [...pending.values()].map(
      (operation) => operation.promise,
    );
    completion.push(...acceptedReads.keys(), ...acceptedTeardowns);
    await Promise.allSettled(completion);
    readers.delete(authority);
    teardownReaders.delete(authority);
    lifetimeJobs.delete(authority);
    retireMobilePublicationAuthority(authority);
    releaseMobilePublicationAuthority(authority);
  };
  return { join, assertCapacity, start, watch, close };
}

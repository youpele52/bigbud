import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import { RpcClient } from "effect/unstable/rpc";

export type MobileRpcRuntime = Pick<
  ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>,
  "dispose" | "runCallback" | "runPromise" | "runSync"
>;

export function createDeferredPromise<A>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function startMobileRpcClientInitialization<A>(input: {
  readonly runtime: MobileRpcRuntime;
  readonly effect: Effect.Effect<A, Error, RpcClient.Protocol>;
  readonly clientPromise?: Promise<A>;
}) {
  const deferred = createDeferredPromise<A>();
  void deferred.promise.catch(() => undefined);
  let cancelInitialization: (() => void) | null = null;
  if (input.clientPromise) {
    void input.clientPromise.then(deferred.resolve, deferred.reject);
  } else {
    let completed = false;
    try {
      const cancel = input.runtime.runCallback(input.effect, {
        onExit: (exit) => {
          completed = true;
          cancelInitialization = null;
          if (Exit.isSuccess(exit)) deferred.resolve(exit.value);
          else deferred.reject(Cause.squash(exit.cause));
        },
      });
      if (!completed) cancelInitialization = cancel;
    } catch (error) {
      deferred.reject(error);
    }
  }
  return {
    promise: deferred.promise,
    reject: deferred.reject,
    cancel: () => {
      cancelInitialization?.();
      cancelInitialization = null;
    },
  };
}

function noopCancel() {}

export function runCancellable<A, E>(input: {
  readonly runtime: MobileRpcRuntime;
  readonly effect: Effect.Effect<A, E, RpcClient.Protocol>;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}) {
  return new Promise<A>((resolve, reject) => {
    let settled = false;
    let cancel: (interruptor?: number) => void = noopCancel;
    const timeoutId = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      cancel();
      cleanup();
      reject(new Error("Timed out waiting for mobile recovery."));
    }, input.timeoutMs);
    const cleanup = () => {
      globalThis.clearTimeout(timeoutId);
      input.signal?.removeEventListener("abort", abort);
    };
    const finish = (exit: Exit.Exit<A, E>) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (Exit.isSuccess(exit)) {
        resolve(exit.value);
      } else {
        reject(exit.cause);
      }
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cancel();
      cleanup();
      reject(new Error("Mobile recovery request was cancelled."));
    };
    if (input.signal?.aborted) {
      abort();
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      cancel = input.runtime.runCallback(input.effect, { onExit: finish });
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

import { AsyncLocalStorage } from "node:async_hooks";

interface Caller {
  readonly signal: AbortSignal;
  readonly send: boolean;
  nativeSessionId?: string;
  dispatched: boolean;
}
const callers = new AsyncLocalStorage<Caller | undefined>();
export const currentV2CallerSignal = () => callers.getStore()?.signal;

/** The Effect request owns pre-admission cancellation, not an already issued native operation. */
export function runV2Caller<T>(signal: AbortSignal, send: boolean, run: () => T): T {
  return callers.run({ signal, send, dispatched: false }, run);
}
export function runDetachedV2Caller<T>(run: () => T): T {
  return callers.run(undefined, run);
}
export function assertV2CallerCurrent() {
  const caller = callers.getStore();
  if (caller && !caller.dispatched) caller.signal.throwIfAborted();
}
/** A queued helper retains this caller, not whichever caller is ambient when it resumes. */
export function captureV2CallerGuard() {
  const caller = callers.getStore();
  return () => {
    if (caller && !caller.dispatched) caller.signal.throwIfAborted();
  };
}
export function bindV2CallerSession(nativeSessionId: string) {
  const caller = callers.getStore();
  if (caller?.send) {
    if (caller.nativeSessionId && caller.nativeSessionId !== nativeSessionId)
      throw new Error("V2 caller native session changed.");
    caller.nativeSessionId = nativeSessionId;
  }
}
/** Called synchronously at the guarded fetch boundary, after every await and before fetch issuance. */
export function guardV2CallerFetch(url: URL, method: string) {
  assertV2CallerCurrent();
  const caller = callers.getStore();
  if (
    caller?.send &&
    method === "POST" &&
    url.pathname === `/api/session/${encodeURIComponent(caller.nativeSessionId ?? "")}/prompt`
  )
    caller.dispatched = true;
}

/** Controlled opaque-token/IO model only; not a native service, process, or CAS proof. */
import { expect } from "vitest";
import {
  type MobileActivationNativePort,
  type MobileActivationWorker,
} from "./mobileGatewayActivation.worker.ts";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export function workerFixture() {
  const selection = Object.freeze({ release: "controlled-fixture" });
  const pending = Object.freeze({ pending: true }),
    lease = Object.freeze({ lease: true }),
    exit = Object.freeze({ exit: true }),
    cancelled = Object.freeze({ cancelled: true });
  const detach = new AbortController(),
    stop = new AbortController();
  const events: string[] = [];
  const state = { pin: false, nativeLive: false, cancellationFence: false, nodeDetached: false };
  const native: Mutable<
    MobileActivationNativePort<
      typeof selection,
      typeof pending,
      typeof lease,
      typeof exit,
      typeof cancelled
    >
  > = {
    prepareStart: (value) => {
      expect(value).toBe(selection);
      events.push("prepare");
      return pending;
    },
    start: async (value) => {
      expect(value).toBe(pending);
      expect(state.pin).toBe(true);
      if (state.cancellationFence) throw Error("Original nonce permanently cancelled.");
      events.push("start");
      state.nativeLive = true;
      return lease;
    },
    reconcile: async () => {
      events.push("reconcile");
      return { kind: "uncertain" };
    },
    detach: async (value) => {
      expect(value).toBe(lease);
      events.push("detach");
      state.nodeDetached = true;
    },
    stop: async (value) => {
      expect(value).toBe(lease);
      events.push("stop");
      state.nativeLive = false;
      return exit;
    },
  };
  const input: Mutable<
    MobileActivationWorker<
      typeof selection,
      typeof pending,
      typeof lease,
      typeof exit,
      typeof cancelled,
      number
    >
  > = {
    native,
    detach: detach.signal,
    stop: stop.signal,
    withSelection: async (_signal, use) => {
      events.push("select");
      return use(selection);
    },
    reserve: async (value, selected) => {
      expect(value).toBe(pending);
      expect(selected).toBe(selection);
      events.push("reserve");
      state.pin = true;
    },
    cancelUnlaunched: async (value) => {
      expect(value).toBe(pending);
      events.push("cancel-unlaunched");
      expect(state.nativeLive).toBe(false);
      state.pin = false;
    },
    cancelRejected: async (value, proof) => {
      expect(value).toBe(pending);
      expect(proof).toBe(cancelled);
      expect(state.cancellationFence).toBe(true);
      events.push("cancel-rejected");
      state.pin = false;
    },
    recordExit: async (value, owned, proof) => {
      expect(value).toBe(pending);
      expect(owned).toBe(lease);
      expect(proof).toBe(exit);
      events.push("record-exit");
      expect(state.nativeLive).toBe(false);
      state.pin = false;
    },
    use: async (value) => {
      expect(value).toBe(lease);
      events.push("use");
      return 42;
    },
  };
  return { input, native, pending, lease, exit, cancelled, selection, detach, stop, events, state };
}

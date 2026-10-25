import { MessageChannel } from "node:worker_threads";

import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";

import type { V2ConsentPermit } from "./Application.consent.ts";
import { currentV2RequestContext, runV2RequestContext } from "./Client.guard.ts";
import {
  captureV2AsyncContext,
  v2TryPromise,
  withV2CallerAsyncContext,
} from "./Client.guard.async.ts";
import { assertV2CallerCurrent, runV2Caller } from "./Runtime.caller.ts";

const permit: V2ConsentPermit = {
  revision: 1,
  signal: new AbortController().signal,
  assertCurrent: () => {},
  release: () => {},
};

// Like the SQLite worker bridge: one listener registered outside any caller's context answers
// every request, so fibers resume in the listener's context rather than the caller's.
const { port1, port2 } = new MessageChannel();
const waiting: Array<() => void> = [];
port1.on("message", () => waiting.shift()?.());
const workerBoundary = Effect.callback<void>((resume) => {
  waiting.push(() => resume(Effect.void));
  port2.postMessage(null);
});
afterAll(() => {
  port1.close();
  port2.close();
});

const transportAfterBoundary = Effect.gen(function* () {
  yield* workerBoundary;
  return yield* v2TryPromise({
    try: async () => currentV2RequestContext()?.transport,
    catch: () => new Error("context probe failed"),
  });
});

const inCaller = <T>(transport: string, run: () => T) =>
  runV2RequestContext({ transport, permit, intent: "execute" }, run);

it("loses request authority after a worker-style boundary when no caller context is carried", async () => {
  const observe = (transport: string) =>
    inCaller(transport, () => Effect.runPromise(transportAfterBoundary));
  expect(await Promise.all([observe("first"), observe("second")])).toEqual([undefined, undefined]);
});

it("re-enters each caller's request authority through the fiber-local caller context", async () => {
  const observe = (transport: string) =>
    inCaller(transport, () => Effect.runPromise(withV2CallerAsyncContext(transportAfterBoundary)));
  expect(await Promise.all([observe("first"), observe("second")])).toEqual(["first", "second"]);
});

it("captures a snapshot runner usable outside Effect", async () => {
  const enter = inCaller("snapshot", () => captureV2AsyncContext());
  expect(enter(() => currentV2RequestContext()?.transport)).toBe("snapshot");
  expect(currentV2RequestContext()).toBeUndefined();
});

it("keeps a captured caller fence bound to its own caller once resumed elsewhere", () => {
  const aborted = new AbortController();
  aborted.abort();
  const enter = runV2Caller(aborted.signal, true, () => captureV2AsyncContext());
  // Resumed with no ambient caller (as after worker SQL), the bare fence silently passes.
  expect(() => assertV2CallerCurrent()).not.toThrow();
  expect(() => enter(() => assertV2CallerCurrent())).toThrow();
});

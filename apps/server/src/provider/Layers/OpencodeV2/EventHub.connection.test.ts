import { expect, it, vi } from "vitest";
import { checkedV2EventConnection } from "./EventHub.connection.ts";
import { fixtureEvent } from "./Test.fixtures.ts";

it("rejects a missing/malformed first marker and cancels the original live-only source", async () => {
  let signal: AbortSignal | undefined;
  const source = checkedV2EventConnection({
    signal: new AbortController().signal,
    subscribe: async function* (captured) {
      signal = captured;
      yield fixtureEvent();
    },
  });
  await expect(source.next()).rejects.toThrow("server.connected");
  expect(signal?.aborted).toBe(true);
});

it("keepalive activity extends idle time but cannot extend initial marker qualification", async () => {
  vi.useFakeTimers();
  try {
    let touch: (() => void) | undefined;
    const source = checkedV2EventConnection({
      signal: new AbortController().signal,
      markerTimeoutMs: 20,
      idleTimeoutMs: 40,
      subscribe: async function* (_signal, activity) {
        touch = activity;
        yield { type: "server.connected", id: "connected", data: {} };
        await new Promise(() => {});
      },
    });
    expect((await source.next()).value?.type).toBe("server.connected");
    const pending = source.next();
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30);
    touch?.();
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleResponse } from "./codexAppServerManager.handlers.ts";
import { CodexRpcError } from "./codexAppServerManager.errors.ts";
import {
  closeCodexTransport,
  sendCodexRequest,
  writeCodexMessage,
} from "./codexAppServerManager.transport.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";
import { Effect, Option } from "effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { makeThreadOperations } from "../provider/Layers/ProviderService.threadOperations.ts";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";

const contexts: CodexSessionContext[] = [];
function harness(slow = false) {
  const writes: string[] = [];
  const callbacks: (() => void)[] = [];
  const stdin = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      if (slow) callbacks.push(callback);
      else callback();
    },
  });
  const context = {
    session: { sessionEpoch: 7 },
    child: { stdin },
    pending: new Map(),
    nextRequestId: 1,
    stopping: false,
  } as unknown as CodexSessionContext;
  contexts.push(context);
  return { context, writes, callbacks, stdin };
}

afterEach(() => {
  for (const context of contexts.splice(0)) closeCodexTransport(context, new Error("test cleanup"));
  vi.useRealTimers();
});

describe("Codex bounded stdio transport", () => {
  it.each(["thread/compact/start", "config/mcpServer/reload"])(
    "rechecks maintenance admission at actual queued %s dispatch",
    async (method) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { context, writes, callbacks } = harness(true);
      const preceding = writeCodexMessage(context, { method: "initialized" });
      let current = true;
      const directory = {
        getBinding: () => Effect.succeed(Option.none()),
      } as unknown as ProviderSessionDirectoryShape;
      const lease = makeThreadOperations(directory);
      const threadId = ThreadId.makeUnsafe("maintenance");
      const queued = Promise.withResolvers<void>();
      const result = Effect.runPromise(
        lease(
          threadId,
          Effect.tryPromise({
            try: () => {
              const pending = sendCodexRequest(context, method, {}, 20_000, () => current);
              queued.resolve();
              return pending;
            },
            catch: (error) => error as CodexRpcError,
          }),
        ),
      );
      await queued.promise;
      const stop = vi.fn();
      const stopped = Effect.runPromise(lease(threadId, Effect.sync(stop), true));
      const rejected = expect(result).rejects.toMatchObject({ delivery: "not-dispatched" });
      const startedAt = Date.now();
      current = false;
      callbacks.shift()!();
      await preceding;
      await rejected;
      await stopped;
      expect(Date.now()).toBe(startedAt);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(writes).toHaveLength(1);
      expect(context.pending.size).toBe(0);
    },
  );
  it("keeps numeric and string response IDs distinct", async () => {
    const { context } = harness();
    const result = sendCodexRequest(context, "thread/read", {});
    handleResponse(context, { id: "1", result: { wrong: true } });
    expect(context.pending.size).toBe(1);
    handleResponse(context, { id: 1, result: { correct: true } });
    await expect(result).resolves.toEqual({ correct: true });
    expect(context.pending.size).toBe(0);
  });

  it("waits for callback and drain before writing the next message", async () => {
    const { context, writes, callbacks } = harness(true);
    const first = writeCodexMessage(context, { id: 1 });
    const second = writeCodexMessage(context, { id: 2 });
    expect(writes).toHaveLength(1);
    callbacks.shift()!();
    await first;
    expect(writes).toHaveLength(2);
    callbacks.shift()!();
    await second;
    expect(writes.map((line) => JSON.parse(line).id)).toEqual([1, 2]);
  });

  it("removes pending requests immediately on a synchronous stdin failure", async () => {
    const { context, stdin } = harness();
    vi.spyOn(stdin, "write").mockImplementation(() => {
      throw new Error("write failed");
    });
    await expect(sendCodexRequest(context, "turn/start", {})).rejects.toMatchObject({
      delivery: "possibly-applied",
      method: "turn/start",
      epoch: 7,
    });
    expect(context.pending.size).toBe(0);
  });

  it("preserves code and sanitized bounded data even without an error message", async () => {
    const { context } = harness();
    const result = sendCodexRequest(context, "thread/revert", {});
    handleResponse(context, {
      id: 1,
      error: { code: -32603, data: { reason: "reload failed", token: "secret" } },
    });
    await expect(result).rejects.toMatchObject({
      code: -32603,
      data: { reason: "reload failed", token: "[redacted]" },
      delivery: "possibly-applied",
    });
  });

  it("rejects malformed acknowledgements as possibly applied", async () => {
    const { context } = harness();
    const result = sendCodexRequest(context, "turn/start", {});
    handleResponse(context, { id: 1 });
    await expect(result).rejects.toMatchObject({ delivery: "possibly-applied" });
  });

  it("does not dispatch a queued request after its timeout", async () => {
    vi.useFakeTimers();
    const { context, writes, callbacks } = harness(true);
    const active = writeCodexMessage(context, { method: "initialized" });
    const result = sendCodexRequest(context, "turn/start", {}, 10);
    const rejected = expect(result).rejects.toMatchObject({ delivery: "not-dispatched" });
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    callbacks.shift()!();
    await active;
    expect(writes).toHaveLength(1);
    expect(context.pending.size).toBe(0);
  });

  it("distinguishes active and queued requests when the process exits", async () => {
    const { context } = harness(true);
    const active = sendCodexRequest(context, "turn/start", {});
    const queued = sendCodexRequest(context, "turn/steer", {});
    closeCodexTransport(context, new Error("SSH disconnected"));
    await expect(active).rejects.toMatchObject({ delivery: "possibly-applied" });
    await expect(queued).rejects.toMatchObject({ delivery: "not-dispatched" });
    expect(context.pending.size).toBe(0);
  });

  it("enforces its byte bound before a write", async () => {
    const { context, writes } = harness();
    await expect(
      writeCodexMessage(context, { data: "x".repeat(16 * 1024 * 1024) }),
    ).rejects.toBeInstanceOf(CodexRpcError);
    expect(writes).toHaveLength(0);
  });
});

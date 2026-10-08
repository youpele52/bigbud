import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred, fixtureEvent, flushMicrotasks } from "./Test.fixtures.ts";

const threadId = ThreadId.makeUnsafe("review-boundaries");
const modelSelection = {
  provider: "opencodeV2",
  model: "synthetic-model",
  subProviderID: "synthetic-provider",
} as const;
const input = {
  threadId,
  requestMessageId: MessageId.makeUnsafe("review-input"),
  input: "synthetic input",
  modelSelection,
};

it("serializes startup recovery with hub repair so a blocked final publication cannot be emitted twice", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const started = await runtime.start({
      threadId,
      modelSelection,
      cwd: directory,
      runtimeMode: "approval-required",
    });
    await runtime.send(input);
    const nativeId = runtime.get(threadId).native.id;
    const lease = await runtime.options.manager.acquire(runtime.options.config);
    await runtime.stop(threadId);
    events.length = 0;
    const gate = deferred<void>();
    const entered = deferred<void>();
    const emit = runtime.options.emit;
    let publications = 0;
    vi.spyOn(runtime.options, "emit").mockImplementation(async (event) => {
      if (event.type === "item.completed" && ++publications === 1) {
        entered.resolve();
        await gate.promise;
      }
      await emit(event);
    });
    const resumed = runtime.start({
      threadId,
      modelSelection,
      cwd: directory,
      runtimeMode: "approval-required",
      resumeCursor: started.resumeCursor,
    });
    await entered.promise;
    http.source.push(fixtureEvent(nativeId, "/wrong"));
    await flushMicrotasks();
    expect(publications).toBe(1);
    gate.resolve();
    await resumed;
    await expect.poll(() => runtime.get(threadId).lease.hub.isDirty(nativeId)).toBe(false);
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    await lease.release();
  });
});

for (const mismatch of [
  { id: "different" },
  { providerID: "different" },
  { variant: "different" },
]) {
  it(`rejects native model rebind ${JSON.stringify(mismatch)} before prompt dispatch and retains history`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const started = await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      const native = http.sessions.get(runtime.get(threadId).native.id)!;
      const lease = await runtime.options.manager.acquire(runtime.options.config);
      await runtime.stop(threadId);
      native.model = { ...native.model!, ...mismatch };
      await expect(
        runtime.start({
          threadId,
          modelSelection,
          cwd: directory,
          runtimeMode: "approval-required",
          resumeCursor: started.resumeCursor,
        }),
      ).rejects.toThrow("model/variant rebind");
      expect(http.sessions.has(native.id)).toBe(true);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      await lease.release();
    });
  });
}

it("rejects native selection drift after acquisition before writing journal intent", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    await runtime.start({
      threadId,
      modelSelection,
      cwd: directory,
      runtimeMode: "approval-required",
    });
    http.sessions.get(runtime.get(threadId).native.id)!.model = {
      providerID: "other-provider",
      id: "other-model",
    };
    await expect(runtime.send(input)).rejects.toThrow("model/variant rebind");
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    expect(runtime.get(threadId).row).toBeUndefined();
  });
});

it("coalesces hostile Location bursts and repairs fresh invalidations received during a blocked projection", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    http.autoComplete = false;
    await runtime.start({
      threadId,
      modelSelection,
      cwd: directory,
      runtimeMode: "approval-required",
    });
    await runtime.send(input);
    const session = runtime.get(threadId);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const list = http.client.message.list;
    let held = true;
    const reads = vi.spyOn(http.client.message, "list").mockImplementation(async (...args) => {
      const snapshot = await list(...args);
      if (held) {
        held = false;
        entered.resolve();
        await gate.promise;
      }
      return snapshot;
    });
    http.source.push(fixtureEvent(session.native.id, "/wrong"));
    await entered.promise;
    const dirty = vi.spyOn(runtime, "scheduleRepair");
    for (let index = 0; index < 1000; index++)
      http.source.push(fixtureEvent(session.native.id, "/wrong"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dirty.mock.calls.length).toBeLessThanOrEqual(1);
    expect(reads).toHaveBeenCalledTimes(1);
    http.complete(session.native.id);
    gate.resolve();
    await expect.poll(() => session.terminalDelivered).toBe(true);
    await expect.poll(() => session.lease.hub.isDirty(session.native.id)).toBe(false);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(reads.mock.calls.length).toBeLessThan(8);
  });
});

it("historical retry cannot stall success but current incomplete/retrying output cannot settle", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    http.autoComplete = false;
    await runtime.start({
      threadId,
      modelSelection,
      cwd: directory,
      runtimeMode: "approval-required",
    });
    await runtime.send(input);
    const session = runtime.get(threadId);
    http.complete(session.native.id);
    const messages = http.messages.get(session.native.id)!;
    const success = messages.find((message) => message.type === "assistant")!;
    if (success.type !== "assistant") throw new Error("fixture");
    const previous = {
      ...success,
      id: "msg_retry_history",
      content: [],
      retry: { attempt: 1, at: 3, error: { type: "synthetic", message: "transient" } },
      finish: "error" as const,
    };
    messages.splice(1, 0, previous);
    delete success.time.completed;
    await runtime.reconcile(session);
    expect(session.row?.state).toBe("accepted");
    success.time.completed = 4;
    success.retry = previous.retry;
    await runtime.reconcile(session);
    expect(session.row?.state).toBe("accepted");
    delete success.retry;
    await expect.poll(() => session.terminalDelivered).toBe(true);
    expect(session.row?.finalText).toBe("authoritative full output");
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });
});

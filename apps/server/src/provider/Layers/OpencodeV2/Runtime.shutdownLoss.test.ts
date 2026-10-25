import { Effect } from "effect";
import { expect, it } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { deferred } from "./Test.fixtures.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;
for (const timing of ["during", "after"] as const) {
  it(`accepted loss terminalizes once from proof ${timing} rejected close with polling stopped, and retries failed publication`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      http.autoComplete = false;
      const threadId = ThreadId.makeUnsafe(`shutdown-loss-${timing}`);
      await runtime.start({
        threadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        modelSelection,
        input: "accepted native",
        requestMessageId: MessageId.makeUnsafe(`shutdown-message-${timing}`),
      });
      const owner = runtime.get(threadId),
        row = owner.row!;
      http.forms.set(owner.native.id, [
        {
          id: "frm_shutdown",
          sessionID: owner.native.id,
          title: "Choice",
          fields: [{ key: "answer", type: "string" }],
          state: { status: "pending" },
        },
      ]);
      for (const event of await pendingV2Interactions(owner)) await runtime.emit(owner, event);
      const beforeLoss = events.map((event) => event.eventId);
      const sink = runtime.options.emit;
      const outputReady = deferred<void>();
      const outputEntered = deferred<void>();
      let publishAllowed = false,
        closureCalls = 0;
      Object.assign(runtime.options, {
        emit: async (event: Parameters<typeof sink>[0]) => {
          if (event.type === "content.delta") {
            outputEntered.resolve();
            await outputReady.promise;
          }
          if (event.type === "user-input.resolved") {
            closureCalls++;
            if (!publishAllowed) throw new Error("shutdown sink unavailable");
          }
          await sink(event);
        },
      });
      let exited = false;
      const proveExit = () => {
        exited = true;
        for (const listener of http.deaths) listener();
      };
      Object.assign(owner.lease.process, {
        isRunning: () => false,
        hasExited: () => exited,
        close: async () => {
          if (timing === "during") proveExit();
          else if (!exited) throw new Error("native close unconfirmed");
        },
      });
      const finalOutput = runtime.withSession(threadId, async () => {
        await runtime.emit(owner, {
          ...runtimeEventBase(owner, "last-queued-native-output"),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "last native bytes", contentIndex: 0 },
        });
      });
      await outputEntered.promise;
      http.die();
      const closing = expect(runtime.close()).rejects.toThrow();
      outputReady.resolve();
      await finalOutput;
      await closing;
      if (timing === "after") {
        expect((await Effect.runPromise(runtime.options.journal.find(row)))?.state).toBe(
          "accepted",
        );
        expect(runtime.teardown.has(threadId)).toBe(true);
        proveExit();
      }
      await expect
        .poll(async () => (await Effect.runPromise(runtime.options.journal.find(row)))?.state)
        .toBe("terminal");
      expect(owner.row?.terminalOutcome).toBe("interrupted");
      expect(runtime.teardown.has(threadId)).toBe(true);
      expect(events.some((event) => event.type === "turn.aborted")).toBe(false);
      publishAllowed = true;
      await expect.poll(() => runtime.teardown.has(threadId), { timeout: 4000 }).toBe(false);
      expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
      expect(events.filter((event) => event.type === "session.exited")).toHaveLength(1);
      const closure = events.findIndex((event) => event.type === "user-input.resolved");
      const outputIndex = events.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "last native bytes",
      );
      expect(outputIndex).toBeGreaterThanOrEqual(beforeLoss.length);
      expect(closure).toBeGreaterThan(outputIndex);
      expect(closure).toBeGreaterThanOrEqual(beforeLoss.length);
      expect(events.findIndex((event) => event.type === "turn.aborted")).toBeGreaterThan(closure);
      expect(events.findIndex((event) => event.type === "session.exited")).toBeGreaterThan(
        events.findIndex((event) => event.type === "turn.aborted"),
      );
      expect(events.slice(0, beforeLoss.length).map((event) => event.eventId)).toEqual(beforeLoss);
      expect(closureCalls).toBeLessThanOrEqual(3);
      expect(http.deaths.size).toBe(0);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      await runtime.close();
    });
  });
}

it("shutdown retains one hung publication and bounded owner until raw sink settlement; retries never duplicate raw dispatch", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    http.autoComplete = false;
    const threadId = ThreadId.makeUnsafe("shutdown-hung-publish");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    await runtime.send({
      threadId,
      modelSelection,
      input: "native",
      requestMessageId: MessageId.makeUnsafe("shutdown-hung-message"),
    });
    const owner = runtime.get(threadId);
    let exited = false,
      attempts = 0;
    const pending = deferred<void>(),
      sink = runtime.options.emit;
    Object.assign(runtime.options, {
      emit: async (event: Parameters<typeof sink>[0]) => {
        if (event.type === "turn.aborted") {
          attempts++;
          await pending.promise;
        }
        await sink(event);
      },
    });
    Object.assign(owner.lease.process, {
      isRunning: () => false,
      hasExited: () => exited,
      close: async () => {
        if (!exited) throw new Error("unknown");
      },
    });
    http.die();
    await owner.operation;
    await expect(runtime.close()).rejects.toThrow();
    exited = true;
    for (const listener of http.deaths) listener();
    await expect.poll(() => attempts).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    expect(attempts).toBe(1);
    expect(runtime.teardown.has(threadId)).toBe(true);
    pending.resolve();
    await expect.poll(() => runtime.teardown.has(threadId), { timeout: 3000 }).toBe(false);
    expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.exited")).toHaveLength(1);
    expect(http.deaths.size).toBe(0);
    await runtime.close();
  });
}, 10000);

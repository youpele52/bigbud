import { Effect } from "effect";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("accepted native execution stays accepted on transport loss, no abort/exit/resend; late proof alone terminalizes", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    http.autoComplete = false;
    const threadId = ThreadId.makeUnsafe("transport-not-native-death");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    await runtime.send({
      threadId,
      modelSelection,
      input: "still executing",
      requestMessageId: MessageId.makeUnsafe("transport-accepted"),
    });
    const owner = runtime.get(threadId),
      row = owner.row!;
    let nativeExited = false;
    Object.assign(owner.lease.process, { isRunning: () => false, hasExited: () => nativeExited });
    // Reproduce the old SSH signal: transport death notification while the model process remains active.
    http.die();
    await owner.operation;
    await runtime.reconcile(owner);
    expect((await Effect.runPromise(runtime.options.journal.find(row)))?.state).toBe("accepted");
    expect(owner.session.lastError).toContain("unconfirmed");
    expect(owner.session.activeTurnId).toBe(row.turnId);
    expect(
      events.some((event) => event.type === "turn.aborted" || event.type === "session.exited"),
    ).toBe(false);
    await expect(
      runtime.send({ threadId, modelSelection, input: "must not resend" }),
    ).rejects.toThrow();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    nativeExited = true;
    for (const listener of http.deaths) listener();
    await owner.operation;
    expect((await Effect.runPromise(runtime.options.journal.find(row)))?.state).toBe("terminal");
    expect(owner.row?.terminalOutcome).toBe("interrupted");
    expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.exited")).toHaveLength(1);
  });
});

it("stop on unavailable transport is finite unconfirmed cleanup, never a successful native exit", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("stop-unknown-ssh");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    let exited = false;
    Object.assign(owner.lease.process, { isRunning: () => false, hasExited: () => exited });
    await expect(runtime.stop(threadId)).rejects.toThrow("unconfirmed");
    expect(runtime.teardown.has(threadId)).toBe(true);
    expect(events.some((event) => event.type === "session.exited")).toBe(false);
    exited = true;
    http.die();
    expect(runtime.teardown.has(threadId)).toBe(false);
  });
});

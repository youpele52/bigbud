import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { v2RuntimeStatus } from "./Runtime.status.ts";

it("repeated uncertainty and native scheduled retry remain visible without replay or hiding subsequent state transitions", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("retry-owned");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    http.autoComplete = false;
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    await runtime.send({
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("retry"),
      input: "synthetic",
    });
    const session = runtime.get(threadId);
    http.complete(session.native.id);
    const assistant = http.messages
      .get(session.native.id)!
      .find((message) => message.type === "assistant")!;
    if (assistant.type !== "assistant") throw new Error("fixture");
    assistant.retry = {
      attempt: 2,
      at: Date.now() + 1000,
      error: { type: "unknown", message: "synthetic retry" },
    };
    await runtime.reconcile(session);
    expect(
      events.some(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.reason?.includes("Native retry 2"),
      ),
    ).toBe(true);
    expect(session.row?.state).toBe("accepted");
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    await expect(
      runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("retry-duplicate"),
        input: "new",
      }),
    ).rejects.toThrow();
    await v2RuntimeStatus(runtime, session, "error", "unconfirmed; no resend");
    await v2RuntimeStatus(runtime, session, "running");
    await v2RuntimeStatus(runtime, session, "error", "unconfirmed; no resend");
    await v2RuntimeStatus(runtime, session, "running");
    expect(
      events.filter(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.state === "running" &&
          !event.payload.reason,
      ),
    ).toHaveLength(2);
    delete session.runtimeState;
    await v2RuntimeStatus(runtime, session, "running");
    expect(
      events.filter(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.state === "running" &&
          !event.payload.reason,
      ),
    ).toHaveLength(3);
    delete assistant.retry;
    await runtime.reconcile(session);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
  });
});

it("physical process loss during unconfirmed admission never invents an interrupted accepted turn or resends", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("unknown-lost");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    http.autoComplete = false;
    http.loseAck = true;
    http.hideAdmission = true;
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    await expect(
      runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("unknown"),
        input: "synthetic",
      }),
    ).rejects.toThrow();
    const session = runtime.get(threadId);
    http.die();
    await expect.poll(() => events.some((event) => event.type === "session.exited")).toBe(true);
    expect(session.row?.state).toBe("dispatch-intent");
    expect(
      events.some((event) => event.type === "turn.aborted" || event.type === "turn.completed"),
    ).toBe(false);
    expect(events.find((event) => event.type === "session.exited")).toMatchObject({
      payload: {
        recoverable: false,
        reason: expect.stringContaining("admission remains unconfirmed"),
      },
    });
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
  });
});

it("idle cannot terminalize an unfinished tool; repaired completion and usage remain deduplicated", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("active-tool-idle");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    http.autoComplete = false;
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    await runtime.send({
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("tool"),
      input: "synthetic",
    });
    const session = runtime.get(threadId);
    http.complete(session.native.id);
    const assistant = http.messages
      .get(session.native.id)!
      .find((message) => message.type === "assistant")!;
    if (assistant.type !== "assistant") throw new Error("fixture");
    assistant.content.push({
      type: "tool",
      id: "tool_wait",
      name: "webfetch",
      time: { created: 3 },
      state: { status: "running", input: {}, metadata: {} },
    });
    await runtime.reconcile(session);
    expect(session.row?.state).toBe("accepted");
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      ),
    ).toBe(false);
    expect(events.find((event) => event.type === "thread.token-usage.updated")).toMatchObject({
      payload: { accounting: { finalized: false } },
    });
    assistant.content.pop();
    assistant.content.push({
      type: "tool",
      id: "tool_wait",
      name: "webfetch",
      time: { created: 3, completed: 4 },
      state: {
        status: "completed",
        input: {},
        content: [{ type: "text", text: "safe response" }],
        metadata: {},
      },
    });
    await runtime.reconcile(session);
    await runtime.reconcile(session);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      ),
    ).toHaveLength(1);
  });
});

it("failed projection reports visible uncertainty without dispatching again and clears only after authoritative repair", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("repair-ux");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    http.autoComplete = false;
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    await runtime.send({
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("repair"),
      input: "synthetic",
    });
    const session = runtime.get(threadId);
    const read = vi
      .spyOn(http.client.message, "list")
      .mockRejectedValueOnce(new Error("disconnected projection"));
    await runtime.reconcile(session);
    expect(
      events.some(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.state === "error" &&
          event.payload.reason?.includes("no automatic resend"),
      ),
    ).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(session.session.lastError).toContain("message projection state remains unconfirmed");
    expect(session.row?.state).toBe("accepted");
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    http.complete(session.native.id);
    await runtime.reconcile(session);
    await runtime.reconcile(session);
    expect(session.session.lastError).toBeUndefined();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });
});

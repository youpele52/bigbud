import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("a completed native aborted step without idle terminalizes only after authoritative active/admission absence", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("aborted-step");
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
      requestMessageId: MessageId.makeUnsafe("aborted"),
      input: "synthetic",
    });
    const session = runtime.get(threadId);
    const messages = http.messages.get(session.native.id)!;
    messages.push({
      id: "msg_aborted",
      type: "assistant",
      agent: "build",
      model: session.model,
      time: { created: 3, completed: 4 },
      finish: "error",
      error: { type: "aborted", message: "Step interrupted" },
      content: [],
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const active = vi
      .spyOn(http.client.session, "active")
      .mockResolvedValue({ [session.native.id]: { type: "busy" } } as never);
    await runtime.reconcile(session);
    expect(session.row?.state).toBe("accepted");
    active.mockResolvedValue({});
    await runtime.reconcile(session);
    expect(session.row?.state).toBe("accepted"); // The original admission remains pending.
    http.inbox.set(session.native.id, []);
    await runtime.reconcile(session);
    expect(session.row?.state).toBe("terminal");
    expect(session.row?.terminalOutcome).toBe("interrupted");
    await runtime.reconcile(session);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
      state: "interrupted",
    });
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
  });
});

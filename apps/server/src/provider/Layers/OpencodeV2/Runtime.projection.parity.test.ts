import { expect, it } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("projects tools and provisional usage while assistant generation is active, then repairs final output exactly once", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("projection-parity");
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
      requestMessageId: MessageId.makeUnsafe("projection-parity-input"),
      modelSelection,
      input: "synthetic",
    });
    const session = runtime.get(threadId);
    http.complete(session.native.id);
    const messages = http.messages.get(session.native.id)!;
    const assistant = messages.find((message) => message.type === "assistant")!;
    if (assistant.type !== "assistant") throw new Error("fixture");
    messages.pop();
    delete assistant.time.completed;
    assistant.content.push(
      { type: "reasoning", text: "first thought" },
      { type: "reasoning", text: " second thought" },
      {
        type: "tool",
        id: "tool_shared",
        name: "synthetic_tool",
        time: { created: 3 },
        state: { status: "running", input: { synthetic: true }, metadata: { progress: "first" } },
      },
    );
    await runtime.reconcile(session);
    expect(
      events.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "dynamic_tool_call",
      ),
    ).toHaveLength(1);
    expect(events.find((event) => event.type === "thread.token-usage.updated")).toMatchObject({
      payload: { accounting: { finalized: false } },
    });
    const tool = assistant.content.find((part) => part.type === "tool")!;
    if (tool.type !== "tool") throw new Error("fixture");
    tool.state = {
      status: "running",
      input: { synthetic: true },
      metadata: { progress: "second" },
    };
    await runtime.reconcile(session);
    expect(
      events.some(
        (event) => event.type === "item.updated" && event.payload.title === "synthetic_tool",
      ),
    ).toBe(true);
    tool.state = {
      status: "completed",
      input: { synthetic: true },
      content: [{ type: "text", text: "full tool output" }],
    };
    assistant.time.completed = 4;
    messages.push({
      id: "msg_idle_parity",
      type: "idle",
      outcome: "succeeded",
      time: { created: 5 },
    });
    await runtime.reconcile(session);
    await runtime.reconcile(session);
    expect(
      events.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      ),
    ).toMatchObject([{ payload: { detail: "full tool output", status: "completed" } }]);
    expect(
      events.filter(
        (event) => event.type === "item.completed" && event.payload.itemType === "reasoning",
      ),
    ).toMatchObject([{ payload: { detail: "first thought second thought" } }]);
    expect(
      events.filter(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.accounting?.finalized,
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });
});

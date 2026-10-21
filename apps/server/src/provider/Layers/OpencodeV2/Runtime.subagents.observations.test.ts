import { expect, it, vi } from "vitest";
import { MessageId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { startRunning, addChild, taskEvents } from "./Runtime.subagents.fixture.ts";
import { noteV2ChildHint } from "./Runtime.subagents.ts";

it("demotes a disappeared live child without claiming completion or forgetting a terminal child", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "missing-observation");
    addChild(http, session);
    addChild(http, session, { id: "ses_done", outcome: "succeeded" });
    vi.spyOn(http.client.session, "active").mockResolvedValue({ ses_child: { type: "running" } });
    await runtime.reconcile(session);
    http.sessions.delete("ses_child");
    http.sessions.delete("ses_done");
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload).toMatchObject({
      kind: "providerSubagent",
      nativeId: "ses_child",
      status: "inProgress",
      activityFresh: false,
    });
    expect(
      taskEvents(events).filter((event) => event.payload.nativeId === "ses_done"),
    ).toHaveLength(1);
    await runtime.reconcile(session);
    expect(taskEvents(events)).toHaveLength(3);
    expect(session.row?.state).toBe("accepted");
  });
});

it("retains the original child turn while a newer parent turn is current", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "original-child-turn");
    addChild(http, session);
    const assistant = http.messages
      .get(session.native.id)!
      .find((message) => message.type === "assistant")!;
    if (assistant.type !== "assistant" || assistant.content[0]?.type !== "tool")
      throw new Error("fixture tool missing");
    assistant.content[0].state = {
      status: "running",
      input: {},
      metadata: { sessionID: "ses_child" },
    };
    vi.spyOn(http.client.session, "active").mockResolvedValue({ ses_child: { type: "running" } });
    await runtime.reconcile(session);
    const original = session.row!;
    expect(taskEvents(events).at(-1)?.payload.turnId).toBe(original.turnId);
    assistant.content = []; // The next turn no longer projects the original native launch call.
    session.row = { ...original, turnId: TurnId.makeUnsafe("newer-parent-turn") };
    addChild(http, session, { title: "Still doing the original assignment" });
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload.turnId).toBe(original.turnId);
    expect(taskEvents(events).every((event) => event.turnId === undefined)).toBe(true);
  });
});

it("does not invent turn B attribution when turn A child discovery failed and B has no matching launch", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "delayed-child-turn");
    addChild(http, session);
    const assistant = http.messages
      .get(session.native.id)!
      .find((message) => message.type === "assistant")!;
    if (assistant.type !== "assistant" || assistant.content[0]?.type !== "tool")
      throw new Error("fixture tool missing");
    assistant.content[0].state = {
      status: "completed",
      input: {},
      content: [{ type: "text", text: "Child launched" }],
      metadata: { sessionID: "ses_child" },
    };
    assistant.time.completed = 4;
    const list = vi
      .spyOn(http.client.session, "list")
      .mockRejectedValue(new Error("turn A child read failed"));
    await runtime.reconcile(session);
    expect(taskEvents(events)).toHaveLength(0);
    http.complete(session.native.id);
    await runtime.reconcile(session);
    expect(session.row?.state).toBe("terminal");
    const turnA = session.row!.turnId;
    await runtime.send({
      threadId: session.threadId,
      requestMessageId: MessageId.makeUnsafe("delayed-child-turn-B"),
      input: "Unrelated second turn",
    });
    expect(session.row!.turnId).not.toBe(turnA);
    expect(session.row?.state).toBe("accepted");
    list.mockRestore();
    noteV2ChildHint(runtime, session);
    await vi.waitFor(() => expect(taskEvents(events)).toHaveLength(1));
    expect(taskEvents(events)[0]?.payload).toMatchObject({
      kind: "providerSubagent",
      nativeId: "ses_child",
    });
    expect(taskEvents(events)[0]?.payload.turnId).toBeUndefined();
    expect(taskEvents(events)[0]?.turnId).toBeUndefined();
  });
});

it("rejects a regressed child revision without reopening a confirmed terminal", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "regressed-child");
    addChild(http, session, {
      outcome: "succeeded",
      time: { created: 1000, updated: 4000, idle: 3500 },
    });
    await runtime.reconcile(session);
    addChild(http, session, { time: { created: 1000, updated: 2000 } });
    vi.spyOn(http.client.session, "active").mockResolvedValue({ ses_child: { type: "running" } });
    await runtime.reconcile(session);
    expect(taskEvents(events)).toHaveLength(1);
    expect(taskEvents(events)[0]?.payload.status).toBe("completed");
  });
});

it("reads every bounded page before claiming freshness and preserves parent-scoped cursor filters", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "paged-children");
    const first = addChild(http, session);
    const second = addChild(http, session, { id: "ses_second" });
    const list = vi.spyOn(http.client.session, "list").mockImplementation(async (input) => {
      expect(input?.parentID === session.native.id || input?.cursor === "child-page-2").toBe(true);
      return input?.cursor
        ? { data: [second], cursor: {} }
        : { data: [first], cursor: { next: "child-page-2" } };
    });
    vi.spyOn(http.client.session, "active").mockResolvedValue({ ses_second: { type: "running" } });
    await runtime.reconcile(session);
    expect(list).toHaveBeenCalledTimes(2);
    expect(taskEvents(events).map((event) => event.payload.nativeId)).toEqual([
      "ses_child",
      "ses_second",
    ]);
    expect(taskEvents(events).at(-1)?.payload.activityFresh).toBe(true);
  });
});

it("demotes a known child when its location/project identity changes instead of mapping foreign content", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "foreign-observation");
    addChild(http, session);
    vi.spyOn(http.client.session, "active").mockResolvedValue({ ses_child: { type: "running" } });
    await runtime.reconcile(session);
    addChild(http, session, { projectID: "foreign-project", title: "foreign content" });
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload).toMatchObject({
      activityFresh: false,
      description: "Index the docs folder",
    });
    expect(JSON.stringify(taskEvents(events))).not.toContain("foreign content");
  });
});

import { expect, it, vi } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { startRunning, addChild, taskEvents } from "./Runtime.subagents.fixture.ts";

it.each([
  "repeated-cursor",
  "oversized-page",
  "duplicate-child",
  "invalid-active",
  "invalid-active-entry",
  "invalid-cursor",
] as const)("demotes instead of publishing partial child snapshots on %s", async (failure) => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, `partial-${failure}`);
    const child = addChild(http, session);
    const active = vi
      .spyOn(http.client.session, "active")
      .mockResolvedValue({ ses_child: { type: "running" } });
    await runtime.reconcile(session);
    const list = vi.spyOn(http.client.session, "list");
    if (failure === "invalid-active") active.mockResolvedValue(null!);
    else if (failure === "invalid-active-entry") active.mockResolvedValue({ ses_child: null! });
    else
      list.mockResolvedValue({
        data:
          failure === "oversized-page"
            ? Array.from({ length: 33 }, () => child)
            : failure === "duplicate-child"
              ? [child, child]
              : [child],
        cursor:
          failure === "repeated-cursor"
            ? { next: "repeated" }
            : failure === "invalid-cursor"
              ? { next: "" }
              : {},
      });
    await runtime.reconcile(session);
    expect(taskEvents(events)).toHaveLength(2);
    expect(taskEvents(events).at(-1)?.payload).toMatchObject({
      kind: "providerSubagent",
      status: "inProgress",
      activityFresh: false,
    });
    expect(list.mock.calls.length).toBeLessThanOrEqual(2);
    expect(http.calls.filter((call) => call.pathname.includes("ses_child"))).toHaveLength(0);
    expect(session.row?.state).toBe("accepted");
  });
});

it("keeps a stale live revision last-seen until a current read restores freshness", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "stale-live");
    addChild(http, session);
    vi.spyOn(http.client.session, "active").mockResolvedValue({ ses_child: { type: "running" } });
    await runtime.reconcile(session);
    addChild(http, session, { time: { created: 1000, updated: 1500 } });
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload.activityFresh).toBe(false);
    expect(taskEvents(events).at(-1)?.payload.freshness.providerRevision).toBe(2000);
    addChild(http, session);
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload.activityFresh).toBe(true);
    expect(taskEvents(events)).toHaveLength(3);
  });
});

it("publishes a newer provider revision even when visible child content is unchanged", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "newer-child-revision");
    addChild(http, session);
    await runtime.reconcile(session);
    addChild(http, session, { time: { created: 1000, updated: 3000 } });
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload.freshness.providerRevision).toBe(3000);
  });
});

it("maps assignment/background only from exact native child correlation, never a guessed tool", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "child-assignment");
    addChild(http, session);
    const message = http.messages
      .get(session.native.id)!
      .find((item) => item.type === "assistant")!;
    if (message.type !== "assistant") throw new Error("fixture assistant missing");
    const part = message.content[0]!;
    if (part.type !== "tool") throw new Error("fixture tool missing");
    part.state = {
      status: "running",
      input: {
        description: "Review native permission handling",
        prompt: "Investigate the guard",
        background: true,
      },
      metadata: { sessionID: "ses_someone_else" },
    };
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload.background).toBeUndefined();
    part.state.metadata.sessionID = "ses_child";
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload).toMatchObject({
      description: "Review native permission handling",
      prompt: "Investigate the guard",
      background: true,
      parentToolUseId: "tool_subagent",
    });
    // Later root projections may omit the launch call; display data is not a new assignment.
    message.content = [];
    addChild(http, session, { title: "Native title changed after launch" });
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload).toMatchObject({
      description: "Review native permission handling",
      prompt: "Investigate the guard",
      background: true,
    });
    expect(taskEvents(events).every((event) => event.turnId === undefined)).toBe(true);
    expect(http.calls.filter((call) => call.pathname.includes("ses_child"))).toHaveLength(0);
  });
});

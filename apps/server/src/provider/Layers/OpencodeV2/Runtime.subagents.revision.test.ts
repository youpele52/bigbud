import { expect, it, vi } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { startRunning, addChild, taskEvents } from "./Runtime.subagents.fixture.ts";

it("preserves a newer idle outcome/end time when a stale terminal has the same updated revision", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "stale-idle-marker");
    addChild(http, session, {
      outcome: "failed",
      time: { created: 1000, updated: 2000, idle: 4000 },
    });
    await runtime.reconcile(session);
    addChild(http, session, {
      outcome: "succeeded",
      time: { created: 1000, updated: 2000, idle: 3000 },
    });
    await runtime.reconcile(session);
    expect(taskEvents(events)).toHaveLength(1);
    expect(taskEvents(events)[0]?.payload).toMatchObject({
      kind: "providerSubagent",
      status: "failed",
      endedAt: new Date(4000).toISOString(),
      metrics: { durationMs: 3000 },
    });
  });
});

it("accepts a newer idle outcome without requiring time.updated to advance", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "new-idle-marker");
    addChild(http, session, {
      outcome: "failed",
      time: { created: 1000, updated: 2000, idle: 3000 },
    });
    await runtime.reconcile(session);
    addChild(http, session, {
      outcome: "succeeded",
      time: { created: 1000, updated: 2000, idle: 4000 },
    });
    await runtime.reconcile(session);
    expect(taskEvents(events)).toHaveLength(2);
    expect(taskEvents(events).at(-1)?.payload).toMatchObject({
      status: "completed",
      endedAt: new Date(4000).toISOString(),
      freshness: { providerRevision: 2000 },
    });
    expect(taskEvents(events).every((event) => event.turnId === undefined)).toBe(true);
  });
});

it.each(["older-idle", "conflicting-idle", "missing-idle"] as const)(
  "newer unrelated updated revision cannot replace terminal evidence with %s",
  async (conflict) => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const session = await startRunning(runtime, http, directory, `idle-conflict-${conflict}`);
      addChild(http, session, {
        outcome: "succeeded",
        time: { created: 1000, updated: 2000, idle: 4000 },
      });
      await runtime.reconcile(session);
      addChild(http, session, {
        outcome: "interrupted",
        time: {
          created: 1000,
          updated: 5000,
          ...(conflict === "missing-idle" ? {} : { idle: conflict === "older-idle" ? 3000 : 4000 }),
        },
      });
      await runtime.reconcile(session);
      expect(taskEvents(events)).toHaveLength(1);
      expect(taskEvents(events)[0]?.payload).toMatchObject({
        status: "completed",
        endedAt: new Date(4000).toISOString(),
      });
    });
  },
);

it("cannot reopen newer terminal evidence with an updated revision older than its idle marker", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "idle-before-reopen");
    addChild(http, session, {
      outcome: "succeeded",
      time: { created: 1000, updated: 2000, idle: 4000 },
    });
    await runtime.reconcile(session);
    vi.spyOn(http.client.session, "active").mockResolvedValue({ ses_child: { type: "running" } });
    addChild(http, session, { time: { created: 1000, updated: 3000 } });
    await runtime.reconcile(session);
    expect(taskEvents(events)).toHaveLength(1);
    expect(taskEvents(events)[0]?.payload.status).toBe("completed");
  });
});

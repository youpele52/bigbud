import { ThreadId, TurnId } from "@bigbud/contracts";
import type { Event, Session } from "@opencode-ai/sdk/v2";
import { describe, expect, it, vi } from "vitest";

import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { makeChildSessionTracker } from "./Adapter.stream.children.ts";

const child = {
  id: "child-1",
  parentID: "parent-1",
  agent: "reviewer",
  title: "Review changes",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
} as Session;
const session = {
  threadId: ThreadId.makeUnsafe("thread-1"),
  sessionEpoch: 3,
  activeTurnId: TurnId.makeUnsafe("turn-1"),
  opencodeSessionId: "parent-1",
  client: {
    session: {
      children: async ({ sessionID }: { sessionID: string }) => ({
        data: sessionID === "parent-1" ? [child] : [],
      }),
      status: async () => ({ data: { "child-1": { type: "busy" } } }),
    },
  },
} as unknown as ActiveOpencodeSession;

describe("OpenCode child sessions", () => {
  it("discovers child identity and reconciles status without parent content", async () => {
    const tracker = makeChildSessionTracker(session);
    const updates = await tracker.refresh();
    const childStartedAt = "2023-11-14T22:13:20.000Z";
    expect(updates).toMatchObject([
      {
        type: "task.updated",
        payload: {
          nativeId: "child-1",
          status: "pending",
          parentAgentId: "parent-1",
          createdAt: childStartedAt,
        },
      },
      {
        type: "task.updated",
        payload: {
          nativeId: "child-1",
          status: "inProgress",
          activityFresh: true,
          createdAt: childStartedAt,
        },
      },
    ]);
    expect(Date.parse(updates[0]!.createdAt)).toBeGreaterThan(Date.parse(childStartedAt));
    await tracker.handle({
      type: "message.updated",
      properties: { sessionID: "child-1", info: { id: "user-1", role: "user" } },
    } as Event);
    expect(
      await tracker.handle({
        type: "message.part.updated",
        properties: {
          sessionID: "child-1",
          part: {
            id: "prompt-part",
            messageID: "user-1",
            sessionID: "child-1",
            type: "text",
            text: "agent assignment prompt",
          },
        },
      } as Event),
    ).toEqual([]);
    await tracker.handle({
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: { id: "assistant-1", role: "assistant" },
      },
    } as Event);
    const progress = await tracker.handle({
      type: "message.part.delta",
      properties: {
        sessionID: "child-1",
        messageID: "assistant-1",
        partID: "progress-part",
        field: "text",
        delta: "Inspecting the authentication flow",
      },
    } as Event);
    expect(progress).toMatchObject([
      {
        type: "task.updated",
        payload: {
          status: "inProgress",
          activityFresh: true,
          progressSummary: "Inspecting the authentication flow",
        },
      },
    ]);
    const idle = await tracker.handle({
      type: "session.idle",
      properties: { sessionID: "child-1" },
    } as Event);
    expect(idle).toMatchObject([
      {
        type: "task.updated",
        payload: { status: "completed", activityFresh: false, createdAt: childStartedAt },
      },
    ]);
    const nested = await tracker.handle({
      type: "session.created",
      properties: {
        sessionID: "child-2",
        info: { id: "child-2", parentID: "child-1", agent: "writer", title: "Write report" },
      },
    } as Event);
    expect(nested).toMatchObject([
      { type: "task.updated", payload: { nativeId: "child-2", parentAgentId: "child-1" } },
    ]);
  });

  it("marks children idle in a status snapshot as completed", async () => {
    const idleSession = {
      ...session,
      client: {
        session: {
          ...session.client.session,
          status: async () => ({ data: { "child-1": { type: "idle" } } }),
        },
      },
    } as unknown as ActiveOpencodeSession;
    const updates = await makeChildSessionTracker(idleSession).refresh();

    expect(updates.at(-1)).toMatchObject({
      type: "task.updated",
      payload: { status: "completed", activityFresh: false },
    });
  });

  it("coalesces child text deltas while retaining the latest bounded report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T00:00:00.000Z"));
    try {
      const tracker = makeChildSessionTracker(session);
      await tracker.refresh();
      await tracker.handle({
        type: "message.updated",
        properties: {
          sessionID: "child-1",
          info: { id: "assistant-1", role: "assistant" },
        },
      } as Event);
      const delta = (text: string) =>
        tracker.handle({
          type: "message.part.delta",
          properties: {
            sessionID: "child-1",
            messageID: "assistant-1",
            partID: "progress-part",
            field: "text",
            delta: text,
          },
        } as Event);

      expect(await delta("Inspecting ")).toHaveLength(1);
      expect(await delta("the auth flow")).toEqual([]);
      vi.advanceTimersByTime(250);
      expect(await delta(" and its tests")).toMatchObject([
        {
          type: "task.updated",
          payload: {
            progressSummary: "Inspecting the auth flow and its tests",
            activityFresh: true,
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks an errored child as failed", async () => {
    const tracker = makeChildSessionTracker(session);
    await tracker.refresh();

    const updates = await tracker.handle({
      type: "session.error",
      properties: {
        sessionID: "child-1",
        error: { name: "UnknownError", data: { message: "failed" } },
      },
    } as Event);

    expect(updates).toMatchObject([
      { type: "task.updated", payload: { status: "failed", activityFresh: false } },
    ]);
  });

  it("marks aborted or deleted active children as stopped", async () => {
    const abortedTracker = makeChildSessionTracker(session);
    await abortedTracker.refresh();
    const aborted = await abortedTracker.handle({
      type: "session.error",
      properties: {
        sessionID: "child-1",
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      },
    } as Event);
    expect(aborted).toMatchObject([
      { type: "task.updated", payload: { status: "stopped", activityFresh: false } },
    ]);
    const resumed = await abortedTracker.handle({
      type: "session.status",
      properties: { sessionID: "child-1", status: { type: "busy" } },
    } as Event);
    expect(resumed).toMatchObject([
      { type: "task.updated", payload: { status: "inProgress", activityFresh: true } },
    ]);

    const deletedTracker = makeChildSessionTracker(session);
    await deletedTracker.refresh();
    const deleted = await deletedTracker.handle({
      type: "session.deleted",
      properties: { sessionID: "child-1", info: child },
    } as Event);
    expect(deleted).toMatchObject([
      { type: "task.updated", payload: { status: "stopped", activityFresh: false } },
    ]);
  });
});

import { ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import type { Event, Session } from "@opencode-ai/sdk/v2";
import { Effect, ServiceMap } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeChildSessionTracker } from "./Adapter.stream.children.ts";
import { opencodeEventSessionId } from "./Adapter.stream.identity.ts";
import { startEventStream } from "./Adapter.stream.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

const child = {
  id: "child",
  parentID: "parent",
  agent: "code-reviewer",
  title: "Review the changes",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
} as Session;

const event = (type: string, properties: object) => ({ type, properties }) as Event;
const created = () => event("session.created", { info: child });
const assistant = () =>
  event("message.updated", { info: { id: "message", sessionID: "child", role: "assistant" } });
const text = () =>
  event("message.part.updated", {
    part: {
      id: "text",
      messageID: "message",
      sessionID: "child",
      type: "text",
      text: "Inspecting the diff",
    },
  });

function makeSession(eventClient?: unknown): ActiveOpencodeSession {
  return {
    threadId: ThreadId.makeUnsafe("thread"),
    sessionEpoch: 1,
    activeTurnId: TurnId.makeUnsafe("turn-1"),
    opencodeSessionId: "parent",
    client: {
      event: eventClient,
      session: {
        children: vi.fn(async () => ({ data: [] as Session[] })),
        status: vi.fn(async () => ({ data: {} })),
      },
    },
  } as unknown as ActiveOpencodeSession;
}

describe("OpenCode and KiloCode native child routing", () => {
  it.each([created(), assistant(), text()])("reads nested $type identity", (native) => {
    expect(opencodeEventSessionId(native)).toBe("child");
    expect(
      opencodeEventSessionId({
        ...native,
        properties: { ...native.properties, sessionID: "top" },
      } as Event),
    ).toBe("top");
  });

  it.each(["opencode", "kilocode"] as const)(
    "routes legacy child events to %s subagent cards, never the parent conversation",
    async (provider) => {
      const native = [
        created(),
        assistant(),
        text(),
        event("session.idle", { sessionID: "child" }),
        event("message.updated", { info: { sessionID: "unrelated", role: "assistant" } }),
        event("message.part.updated", { part: { sessionID: "unrelated", type: "text" } }),
        event("session.updated", { info: { id: "parent" } }),
      ];
      const session = makeSession({
        subscribe: async (_: unknown, options: { signal: AbortSignal }) => ({
          stream: {
            async *[Symbol.asyncIterator]() {
              yield* native;
              await new Promise<void>((resolve) =>
                options.signal.addEventListener("abort", () => resolve(), { once: true }),
              );
            },
          },
        }),
      });
      const emitted: ProviderRuntimeEvent[] = [];
      const parent = vi.fn((_session: ActiveOpencodeSession, _event: Event) => Effect.void);
      const owner = startEventStream(
        session,
        parent,
        () => Effect.die("Unexpected stream disconnect"),
        (events) => Effect.sync(() => void emitted.push(...events)),
        ServiceMap.empty(),
        undefined,
        { retryDelays: [] },
        provider,
      );
      try {
        await vi.waitFor(() => expect(parent).toHaveBeenCalledTimes(1));
        expect(parent.mock.calls[0]?.[1]).toBe(native.at(-1));
        expect(emitted).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "task.updated",
              provider,
              payload: expect.objectContaining({
                kind: "providerSubagent",
                nativeId: "child",
                subagentType: "code-reviewer",
                description: "Review the changes",
                status: "inProgress",
                progressSummary: "Inspecting the diff",
              }),
            }),
          ]),
        );
        expect(emitted.at(-1)).toMatchObject({ payload: { status: "completed" } });
      } finally {
        owner.stop();
      }
    },
  );

  it("keeps a background child's original turn and ignores late content after completion", async () => {
    const session = makeSession();
    const tracker = makeChildSessionTracker(session);
    await tracker.handle(created());
    await tracker.handle(assistant());
    session.activeTurnId = TurnId.makeUnsafe("turn-2");
    const [progress] = await tracker.handle(text());
    expect(progress).toMatchObject({ turnId: "turn-1", payload: { turnId: "turn-1" } });
    const [done] = await tracker.handle(event("session.idle", { sessionID: "child" }));
    expect(done).toMatchObject({ payload: { status: "completed" } });
    expect(await tracker.handle(text())).toEqual([]);
    expect(await tracker.handle(assistant())).toEqual([]);
    const [renamed] = await tracker.handle(
      event("session.updated", { info: { ...child, title: "Reviewed" } }),
    );
    expect(renamed).toMatchObject({ payload: { status: "completed", description: "Reviewed" } });
    if (done?.type === "task.updated" && renamed?.type === "task.updated")
      expect(renamed.payload.endedAt).toBe(done.payload.endedAt);
    const [resumed] = await tracker.handle(
      event("session.status", { sessionID: "child", status: { type: "busy" } }),
    );
    expect(resumed).toMatchObject({ payload: { status: "inProgress" } });
  });

  it("rediscovers nested children beneath already-known children after reconnect", async () => {
    const session = makeSession();
    const tracker = makeChildSessionTracker(session);
    await tracker.handle(created());
    vi.mocked(session.client.session.children).mockImplementation(
      async (input) =>
        ({
          data: input?.sessionID === "child" ? [{ ...child, id: "nested", parentID: "child" }] : [],
        }) as never,
    );
    expect(await tracker.refresh()).toMatchObject([
      { payload: { nativeId: "nested", parentAgentId: "child", kind: "providerSubagent" } },
    ]);
  });

  it("does not replace an explicit child failure with a later idle snapshot", async () => {
    const session = makeSession();
    const tracker = makeChildSessionTracker(session);
    await tracker.handle(created());
    await tracker.handle(
      event("session.error", { sessionID: "child", error: { name: "UnknownError" } }),
    );
    vi.mocked(session.client.session.status).mockResolvedValue({
      data: { child: { type: "idle" } },
    } as never);
    expect(await tracker.refresh()).toEqual([]);
  });
});

import { ThreadId, TurnId } from "@bigbud/contracts";
import type { Event, Session } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import { makeChildSessionTracker } from "./Adapter.stream.children.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

const child = {
  id: "child",
  parentID: "root",
  title: "Review",
  time: { created: 1, updated: 1 },
} as Session;
const event = (type: string, extra = {}) =>
  ({ type, properties: { sessionID: "child", ...extra } }) as Event;

for (const provider of ["opencode", "kilocode"] as const) {
  describe(`${provider} child reconciliation`, () => {
    it("does not replay an in-flight busy snapshot over a live completion", async () => {
      let resolveStatus!: (value: { data: Record<string, { type: "busy" }> }) => void;
      let statusStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        statusStarted = resolve;
      });
      const session = {
        threadId: ThreadId.makeUnsafe("thread"),
        sessionEpoch: 1,
        activeTurnId: TurnId.makeUnsafe("turn"),
        opencodeSessionId: "root",
        client: {
          session: {
            children: async ({ sessionID }: { sessionID: string }) => ({
              data: sessionID === "root" ? [child] : [],
            }),
            status: () => {
              statusStarted();
              return new Promise((resolve) => {
                resolveStatus = resolve;
              });
            },
          },
        },
      } as unknown as ActiveOpencodeSession;
      const tracker = makeChildSessionTracker(session, provider);
      const refresh = tracker.refresh();
      await started;
      expect(await tracker.handle(event("session.idle"))).toMatchObject([
        { payload: { status: "completed" } },
      ]);
      resolveStatus({ data: { child: { type: "busy" } } });
      const replay = await refresh;
      expect(
        replay.filter(
          (entry) => entry.type === "task.updated" && entry.payload.status === "inProgress",
        ),
      ).toEqual([]);
      expect(
        await tracker.handle(event("session.status", { status: { type: "busy" } })),
      ).toMatchObject([{ payload: { status: "inProgress" } }]);
    });

    it("discards an older overlapping reconnect refresh", async () => {
      let resolveOld!: (value: { data: Record<string, { type: "busy" }> }) => void;
      let statusStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        statusStarted = resolve;
      });
      let reads = 0;
      const session = {
        threadId: ThreadId.makeUnsafe("thread"),
        sessionEpoch: 1,
        opencodeSessionId: "root",
        client: {
          session: {
            children: async ({ sessionID }: { sessionID: string }) => ({
              data: sessionID === "root" ? [child] : [],
            }),
            status: () => {
              if (++reads > 1) return Promise.resolve({ data: { child: { type: "idle" } } });
              statusStarted();
              return new Promise((resolve) => {
                resolveOld = resolve;
              });
            },
          },
        },
      } as unknown as ActiveOpencodeSession;
      const tracker = makeChildSessionTracker(session, provider);
      await tracker.handle(event("session.created", { info: child }));
      const old = tracker.refresh();
      await started;
      expect(await tracker.refresh()).toMatchObject([{ payload: { status: "completed" } }]);
      resolveOld({ data: { child: { type: "busy" } } });
      expect(await old).toEqual([]);
    });

    it("does not treat an unknown native status as evidence of resumption", async () => {
      const session = {
        threadId: ThreadId.makeUnsafe("thread"),
        sessionEpoch: 1,
        opencodeSessionId: "root",
      } as ActiveOpencodeSession;
      const tracker = makeChildSessionTracker(session, provider);
      await tracker.handle(event("session.created", { info: child }));
      await tracker.handle(event("session.idle"));
      expect(
        await tracker.handle(event("session.status", { status: { type: "future-status" } })),
      ).toEqual([]);
    });
  });
}

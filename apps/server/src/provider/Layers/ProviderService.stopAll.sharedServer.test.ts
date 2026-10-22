import { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider";
import type { ProviderSession } from "@bigbud/contracts/orchestration/provider.ts";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Queue } from "effect";

import type { OpencodeServerManagerShape } from "../Services/Opencode/ServerManager.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import { makeSessionMethods } from "./Opencode/Adapter.session.ts";
import { makeMockOpencodeClient } from "./Opencode/Adapter.session.test.helpers.ts";
import { makeRunStopAll } from "./ProviderService.operations.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One shared OpenCode server, reference-counted, as OpenCode and Kilo use in production. */
function sharedServer(timeline: string[]) {
  const state = { references: 0, releases: 0 };
  const client = makeMockOpencodeClient() as { session: Record<string, unknown> };
  client.session.delete = async () => {
    timeline.push("server:delete:start");
    await delay(20);
    timeline.push("server:delete:end");
    return { data: true, error: undefined };
  };
  const manager: OpencodeServerManagerShape = {
    acquire: async (input) => {
      state.references += 1;
      return {
        client: client as never,
        url: "http://127.0.0.1:4096",
        release() {
          state.references -= 1;
          state.releases += 1;
          timeline.push(`server:release:${input?.provider ?? "unknown"}`);
        },
        invalidate() {},
      };
    },
  };
  return { manager, state };
}

const adapterOn = (provider: "opencode" | "kilocode", serverManager: OpencodeServerManagerShape) =>
  Effect.gen(function* () {
    const methods = makeSessionMethods({
      provider,
      sessions: new Map(),
      runtimeEventQueue: yield* Queue.unbounded<ProviderRuntimeEvent>(),
      serverManager,
      serverSettings: {
        getSettings: Effect.succeed({
          providers: { [provider]: { binaryPath: provider } },
        } as never),
      },
      serverConfig: {
        attachmentsDir: "/tmp/attachments",
        stateDir: "/tmp/bigbud-state",
        port: 3773,
        host: "127.0.0.1",
      },
      nextEventId: Effect.succeed(EventId.makeUnsafe("evt-next")),
      makeEventStamp: () =>
        Effect.succeed({ eventId: EventId.makeUnsafe("evt-1"), createdAt: "2026-10-22" }),
      nativeEventLogger: undefined,
      services: yield* Effect.services<never>(),
    });
    for (const index of [1, 2])
      yield* methods.startSession({
        threadId: ThreadId.makeUnsafe(`${provider}-thread-${index}`),
        provider,
        runtimeMode: "full-access",
        cwd: "/tmp/bigbud-project",
      });
    return { provider, listSessions: methods.listSessions, stopAll: methods.stopAll };
  });

describe("provider stop-all on the shared OpenCode server", () => {
  it.effect("stops OpenCode and Kilo concurrently, releasing every shared handle once", () =>
    Effect.gen(function* () {
      const timeline: string[] = [];
      const { manager, state } = sharedServer(timeline);
      const adapters = [
        yield* adapterOn("opencode", manager),
        yield* adapterOn("kilocode", manager),
      ];
      assert.strictEqual(state.references, 4);

      const providerOf = (threadId: ThreadId) => threadId.split("-thread-")[0] as ProviderKind;
      const directory = {
        listThreadIds: () =>
          Effect.succeed(
            ["opencode", "kilocode"].flatMap((p) =>
              [1, 2].map((i) => ThreadId.makeUnsafe(`${p}-thread-${i}`)),
            ),
          ),
        getProvider: (threadId: ThreadId) => Effect.succeed(providerOf(threadId)),
        upsert: (binding: { threadId: ThreadId }) =>
          Effect.sync(() => timeline.push(`directory:stopped:${binding.threadId}`)),
      } as unknown as ProviderSessionDirectoryShape;
      const upsertSessionBinding = (session: ProviderSession) =>
        Effect.sync(() => timeline.push(`binding:${session.threadId}`));
      const analytics = { record: () => Effect.void, flush: Effect.void } as never;

      yield* makeRunStopAll(adapters as never, directory, upsertSessionBinding, analytics);

      assert.deepStrictEqual(state, { references: 0, releases: 4 });
      const firstStop = timeline.findIndex((entry) => entry.startsWith("server:"));
      const lastStop = timeline.findLastIndex((entry) => entry.startsWith("server:"));
      const firstUpsert = timeline.findIndex((entry) => entry.startsWith("directory:"));
      // OpenCode v1 is retired: its sessions are stopped, but its bindings are left untouched.
      assert.deepStrictEqual(
        timeline.filter((entry) => !entry.startsWith("server:")),
        [
          "binding:kilocode-thread-1",
          "binding:kilocode-thread-2",
          "directory:stopped:kilocode-thread-1",
          "directory:stopped:kilocode-thread-2",
        ],
      );
      assert.ok(timeline.slice(0, firstStop).every((entry) => entry.startsWith("binding:")));
      assert.ok(firstUpsert > lastStop);
      // Both providers' session deletes are in flight on the shared server at the same time.
      const starts = timeline.filter((entry) => entry === "server:delete:start").length;
      const firstEnd = timeline.indexOf("server:delete:end");
      assert.strictEqual(starts, 4);
      assert.ok(timeline.slice(0, firstEnd).filter((e) => e === "server:delete:start").length > 2);
      // Each adapter released its own handles; neither released the other's.
      assert.strictEqual(timeline.filter((e) => e === "server:release:opencode").length, 2);
      assert.strictEqual(timeline.filter((e) => e === "server:release:kilocode").length, 2);
    }),
  );
});

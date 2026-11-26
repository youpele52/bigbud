import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import path from "node:path";
import { describe, expect } from "vitest";

import { owner } from "../../persistence/Layers/DirectShellLaunchOwners.test.helpers";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { historyPath } from "./Manager.history-io.ts";
import { historyFileThreadIds } from "./Manager.history.orphans";
import { FakeHostAdapter, makeHostManager } from "./Manager.host.test.helpers.ts";
import { openInput } from "./Manager.test.helpers.ts";

const GONE = "thread-gone";

function hostRow(adapter: FakeHostAdapter, threadId: string, terminalId: string, state: string) {
  const ownerKey = `terminal:${JSON.stringify([threadId, terminalId])}`;
  adapter.ownership.rows.set(ownerKey, {
    ...profileOwner(),
    ownerKey,
    target: "local-terminal-host",
    resourceId: `pty-${terminalId}`,
    state: state as "terminal",
  });
}

const files = (logsDir: string) => ({
  write: (threadId: string, terminalId: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = historyPath(logsDir, threadId, terminalId);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, "prompt$ ");
    }),
  exists: (threadId: string, terminalId: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.exists(historyPath(logsDir, threadId, terminalId));
    }),
});

/** Every candidate except `present` is gone from the projection. */
const goneExcept =
  (...present: ReadonlyArray<string>) =>
  (threadIds: ReadonlyArray<string>) =>
    Effect.succeed(new Set(threadIds.filter((threadId) => !present.includes(threadId))));

describe("historyFileThreadIds", () => {
  it("attributes current history names to their thread and skips legacy names", () => {
    expect(historyFileThreadIds(path.basename(historyPath("/", "thread-a", "default")))).toEqual([
      "thread-a",
    ]);
    // The whole name also decodes as one odd thread id; the sweep requires both to be gone.
    expect(historyFileThreadIds(path.basename(historyPath("/", "thread-a", "pane-2")))).toContain(
      "thread-a",
    );
    expect(historyFileThreadIds("thread-a.log")).toEqual([]);
    expect(historyFileThreadIds("terminal_.log")).toEqual([]);
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "orphaned terminal history sweep (Q1, N8)",
  (it) => {
    it.effect("removes an orphan file once its host owner row settles", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const { manager, logsDir } = yield* makeHostManager(adapter);
        const history = files(logsDir);
        hostRow(adapter, GONE, "host-pane", "may-have-been-sent");
        yield* history.write(GONE, "host-pane");
        yield* history.write(GONE, "plain");

        expect(yield* manager.sweepOrphanedHistory!(goneExcept())).toEqual({
          removed: 1,
          kept: 1,
        });
        expect(yield* history.exists(GONE, "host-pane")).toBe(true);
        expect(yield* history.exists(GONE, "plain")).toBe(false);

        hostRow(adapter, GONE, "host-pane", "terminal");
        expect(yield* manager.sweepOrphanedHistory!(goneExcept())).toEqual({
          removed: 1,
          kept: 0,
        });
        expect(yield* history.exists(GONE, "host-pane")).toBe(false);
      }),
    );

    it.effect("keeps held files: owner records, live sessions and existing threads", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const named = {
          ...owner("named"),
          ownerKey: directShellOwnerKey(GONE, "ssh-pane"),
          pane: { threadId: GONE, terminalId: "ssh-pane" },
        };
        const { manager, logsDir } = yield* makeHostManager(adapter, {
          directShellOwners: {
            get: async () => undefined,
            listForThread: async (threadId: string) => (threadId === GONE ? [named] : []),
          } as never,
        });
        const history = files(logsDir);
        yield* history.write(GONE, "ssh-pane");
        yield* history.write("thread-present", "plain");
        yield* manager.open(openInput({ threadId: "thread-live", terminalId: "live-pane" }));
        yield* history.write("thread-live", "live-pane");
        yield* Effect.promise(() => import("node:fs/promises")).pipe(
          Effect.flatMap((fs) =>
            Effect.promise(() => fs.writeFile(path.join(logsDir, "legacy-thread.log"), "x")),
          ),
        );

        const result = yield* manager.sweepOrphanedHistory!(goneExcept("thread-present"));
        expect(result).toEqual({ removed: 0, kept: 2 });
        expect(yield* history.exists(GONE, "ssh-pane")).toBe(true);
        expect(yield* history.exists("thread-present", "plain")).toBe(true);
        expect(yield* history.exists("thread-live", "live-pane")).toBe(true);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(path.join(logsDir, "legacy-thread.log"))).toBe(true);
      }),
    );

    it.effect("an unreadable owner store deletes nothing", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const { manager, logsDir } = yield* makeHostManager(adapter);
        const history = files(logsDir);
        yield* history.write(GONE, "plain");
        Object.assign(adapter.ownership.store, {
          listTerminalOwners: async () => {
            throw new Error("database locked");
          },
        });
        expect(yield* manager.sweepOrphanedHistory!(goneExcept())).toEqual({
          removed: 0,
          kept: 1,
        });
        expect(yield* history.exists(GONE, "plain")).toBe(true);
      }),
    );
  },
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import path from "node:path";
import { expect } from "vitest";

import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { owner } from "../../persistence/Layers/DirectShellLaunchOwners.test.helpers";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { hostedDirectShellOwner } from "./DirectShellLaunch.hosted";
import { historyPath } from "./Manager.history-io.ts";
import { retainedHistoryTerminalIds } from "./Manager.history.retainedPanes";
import { FakeHostAdapter, makeHostManager } from "./Manager.host.test.helpers.ts";
import type { SessionApiContext } from "./Manager.session.types";
import { openInput } from "./Manager.test.helpers.ts";

const THREAD = "thread-1";

const writeHistory = (logsDir: string, terminalId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = historyPath(logsDir, THREAD, terminalId);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "prompt$ ");
  });

const historyExists = (logsDir: string, terminalId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(historyPath(logsDir, THREAD, terminalId));
  });

function hostRow(
  adapter: FakeHostAdapter,
  terminalId: string,
  state: "may-have-been-sent" | "terminal",
  threadId = THREAD,
) {
  const ownerKey = `terminal:${JSON.stringify([threadId, terminalId])}`;
  adapter.ownership.rows.set(ownerKey, {
    ...profileOwner(),
    ownerKey,
    target: "local-terminal-host",
    resourceId: `pty-${terminalId}`,
    state,
  });
}

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "terminal history cleanup keeps panes with owners (Q1, N8)",
  (it) => {
    it.effect("thread deletion keeps the history of a live host pane and deletes the rest", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const { manager, logsDir } = yield* makeHostManager(adapter);
        // A host PTY with no session (as after a backend restart), one whose owner row is
        // terminal (confirmed gone), a history-only pane, and a pane this close stops.
        hostRow(adapter, "host-pane", "may-have-been-sent");
        hostRow(adapter, "done-pane", "terminal");
        hostRow(adapter, "other-thread-pane", "may-have-been-sent", "thread-2");
        for (const pane of ["host-pane", "done-pane", "plain"]) yield* writeHistory(logsDir, pane);
        yield* manager.open(openInput({ terminalId: "open-pane" }));
        yield* writeHistory(logsDir, "open-pane");

        yield* manager.close({ threadId: THREAD, deleteHistory: true });

        expect(yield* historyExists(logsDir, "host-pane")).toBe(true);
        expect(yield* historyExists(logsDir, "done-pane")).toBe(false);
        expect(yield* historyExists(logsDir, "plain")).toBe(false);
        // Its owner row has not caught up, but this close confirmed the stop.
        expect(yield* historyExists(logsDir, "open-pane")).toBe(false);
      }),
    );

    it.effect("an unreadable host owner table deletes no history", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const { manager, logsDir } = yield* makeHostManager(adapter);
        yield* writeHistory(logsDir, "plain");
        Object.assign(adapter.ownership.store, {
          listTerminalOwners: async () => {
            throw new Error("database locked");
          },
        });
        yield* manager.close({ threadId: THREAD, deleteHistory: true });
        expect(yield* historyExists(logsDir, "plain")).toBe(true);
      }),
    );

    it.effect("a single-pane close keeps history while the pane's host PTY may still run", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const { manager, logsDir } = yield* makeHostManager(adapter);
        hostRow(adapter, "host-pane", "may-have-been-sent");
        yield* writeHistory(logsDir, "host-pane");
        yield* writeHistory(logsDir, "plain");
        yield* manager.close({ threadId: THREAD, terminalId: "host-pane", deleteHistory: true });
        yield* manager.close({ threadId: THREAD, terminalId: "plain", deleteHistory: true });
        expect(yield* historyExists(logsDir, "host-pane")).toBe(true);
        expect(yield* historyExists(logsDir, "plain")).toBe(false);
      }),
    );

    it.effect(
      "direct-shell owner records, hosted records and lost host PTYs all retain their pane",
      () =>
        Effect.gen(function* () {
          const adapter = new FakeHostAdapter();
          hostRow(adapter, "stopped-now", "may-have-been-sent");
          const named = {
            ...owner("named"),
            ownerKey: directShellOwnerKey(THREAD, "named"),
            pane: { threadId: THREAD, terminalId: "named" },
          };
          // A legacy record without pane metadata matches only through a known pane id.
          const hashed = { ...owner("hashed"), ownerKey: directShellOwnerKey(THREAD, "hashed") };
          const stranger = { ...owner("x"), ownerKey: directShellOwnerKey(THREAD, "unknown") };
          const ctx = {
            directShellOwners: {
              listForThread: async (_threadId: string, isPaneKey: (key: string) => boolean) =>
                [named, hashed, stranger].filter(
                  (record) => record.pane !== undefined || isPaneKey(record.ownerKey),
                ),
              listHostedForThread: async () => [
                hostedDirectShellOwner({
                  threadId: THREAD,
                  terminalId: "hosted",
                  executionTargetId: "ssh:host=example.test&user=tester&transport=direct-ssh",
                }),
              ],
            },
            hostLimit: {
              runtime: adapter.runtime,
              sessions: () => Effect.succeed([]),
              roster: () => [
                { threadId: THREAD, terminalId: "lost", ptyId: "pty-lost", lost: true },
                { threadId: THREAD, terminalId: "running", ptyId: "pty-run", lost: false },
              ],
            },
          } as unknown as SessionApiContext;
          const retained = yield* retainedHistoryTerminalIds(
            ctx,
            THREAD,
            ["hashed", "plain", "stopped-now"],
            new Set(["stopped-now"]),
          );
          expect(retained === "unknown" ? retained : [...retained].toSorted()).toEqual([
            "hashed",
            "hosted",
            "lost",
            "named",
          ]);

          const failing = {
            ...ctx,
            directShellOwners: {
              listForThread: async () => {
                throw new Error("locked");
              },
            },
          } as unknown as SessionApiContext;
          expect(yield* retainedHistoryTerminalIds(failing, THREAD, [])).toBe("unknown");
        }),
    );
  },
);

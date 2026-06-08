import fs from "node:fs";
import path from "node:path";

import { CommandId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { gitRefExists } from "./OrchestrationEngineHarness.integration.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";

import {
  THREAD_ID,
  FIXTURE_TURN_ID,
  nowIso,
  waitForSync,
  runtimeBase,
  withHarness,
  seedProjectAndThread,
  startTurn,
} from "./orchestrationEngine.integration.shared.ts";

it.live("recovers claudeAgent sessions after provider stopAll using persisted resume state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-recover-1", "2026-02-24T10:11:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-recover-2", "2026-02-24T10:11:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn before restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-recover-3", "2026-02-24T10:11:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-1",
          messageId: "msg-user-claude-recover-1",
          text: "Before restart",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.adapter.stopAll();
        yield* waitForSync(
          () => harness.adapterHarness!.listActiveSessionIds(),
          (sessionIds) => sessionIds.length === 0,
          "provider stopAll",
        );

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-recover-4", "2026-02-24T10:11:01.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-recover-5", "2026-02-24T10:11:01.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn after restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-recover-6", "2026-02-24T10:11:01.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-2",
          messageId: "msg-user-claude-recover-2",
          text: "After restart",
        });
        yield* waitForSync(
          () => harness.adapterHarness!.getStartCount(),
          (count) => count === 2,
          "claude provider recovery start",
        );

        const recoveredThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.messages.some(
              (message) => message.role === "user" && message.text === "After restart",
            ) &&
            !entry.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
        );
        assert.equal(recoveredThread.session?.providerName, "claudeAgent");
        assert.equal(recoveredThread.session?.threadId, "thread-1");
      }),
    "claudeAgent",
  ),
);

it.live("reverts claudeAgent turns and rolls back provider conversation state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-revert-1", "2026-02-24T10:14:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-revert-2", "2026-02-24T10:14:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v2\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-revert-3", "2026-02-24T10:14:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-1",
          messageId: "msg-user-claude-revert-1",
          text: "First Claude edit",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-revert-4", "2026-02-24T10:14:01.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-revert-5", "2026-02-24T10:14:01.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v3\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-revert-6", "2026-02-24T10:14:01.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-2",
          messageId: "msg-user-claude-revert-2",
          text: "Second Claude edit",
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-2" &&
            entry.checkpoints.length === 2 &&
            entry.session?.providerName === "claudeAgent",
        );

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("cmd-checkpoint-revert-claude"),
          threadId: THREAD_ID,
          turnCount: 1,
          createdAt: nowIso(),
        });

        const revertedThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
        );
        assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
          true,
        );
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
          false,
        );
        assert.deepEqual(harness.adapterHarness!.getRollbackCalls(THREAD_ID), [1]);
      }),
    "claudeAgent",
  ),
);

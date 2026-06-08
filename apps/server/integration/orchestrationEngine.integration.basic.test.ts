import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import { gitRefExists, gitShowFileAtRef } from "./OrchestrationEngineHarness.integration.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import type {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";

import {
  THREAD_ID,
  FIXTURE_TURN_ID,
  runtimeBase,
  withHarness,
  seedProjectAndThread,
  startTurn,
} from "./orchestrationEngine.integration.shared.ts";

it.live("runs a single turn end-to-end and persists checkpoint state in sqlite + git", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      const turnResponse: TestTurnResponse = {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-single-1", "2026-02-24T10:00:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-single-2", "2026-02-24T10:00:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Single turn response.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-single-3", "2026-02-24T10:00:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      };

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-single",
        messageId: "msg-user-single",
        text: "Say hello",
      });
      const finalizedReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );
      if (finalizedReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }
      assert.equal(finalizedReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.messages.some(
            (message) => message.role === "assistant" && message.streaming === false,
          ) &&
          entry.checkpoints.length === 1,
      );
      assert.equal(thread.checkpoints[0]?.status, "ready");
      assert.equal(thread.checkpoints[0]?.checkpointTurnCount, 1);

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.equal(checkpointRows.length, 1);
      assert.equal(checkpointRows[0]?.checkpointTurnCount, 1);
      assert.equal(checkpointRows[0]?.status, "ready");
      assert.deepEqual(checkpointRows[0]?.files, []);

      const ref0 = checkpointRefForThreadTurn(THREAD_ID, 0);
      const ref1 = checkpointRefForThreadTurn(THREAD_ID, 1);
      assert.equal(gitRefExists(harness.workspaceDir, ref0), true);
      assert.equal(gitRefExists(harness.workspaceDir, ref1), true);
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref0, "README.md"), "v1\n");
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref1, "README.md"), "v1\n");
    }),
  ),
);

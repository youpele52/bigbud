import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import fs from "node:fs";
import path from "node:path";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { describe, expect, it } from "vitest";
import {
  asTurnId,
  createHarness,
  registerCheckpointReactorTestCleanup,
  waitForThread,
} from "./CheckpointReactor.test.helpers.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";

describe("exact filesystem checkpoint preflight", () => {
  registerCheckpointReactorTestCleanup();
  it.each([
    { turnCount: 0, replaceRepository: false },
    { turnCount: 1, replaceRepository: false },
    { turnCount: 1, replaceRepository: true },
  ])(
    "refuses an unavailable exact filesystem boundary before native mutation: %j",
    async ({ turnCount, replaceRepository }) => {
      const h = await createHarness({ seedFilesystemCheckpoints: replaceRepository });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const at = new Date().toISOString();
      await Effect.runPromise(
        h.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("session"),
          threadId,
          session: {
            threadId,
            providerName: "codex",
            status: "ready",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: at,
          },
          createdAt: at,
        }),
      );
      for (const count of [1, 2])
        await Effect.runPromise(
          h.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.makeUnsafe(`checkpoint-${count}`),
            threadId,
            turnId: asTurnId(`turn-${count}`),
            checkpointRef: checkpointRefForThreadTurn(threadId, count),
            checkpointTurnCount: count,
            status: "ready",
            files: [],
            completedAt: at,
            createdAt: at,
          }),
        );
      if (replaceRepository) {
        const original = h.provider.service.rewindConversation!;
        const replace: NonNullable<ProviderServiceShape["rewindConversation"]> = (
          input,
          completion,
        ) =>
          Effect.sync(() => {
            fs.cpSync(path.join(h.cwd, ".git"), path.join(h.cwd, ".git-copy"), { recursive: true });
            fs.renameSync(path.join(h.cwd, ".git"), path.join(h.cwd, ".git-old"));
            fs.renameSync(path.join(h.cwd, ".git-copy"), path.join(h.cwd, ".git"));
          }).pipe(Effect.andThen(original(input, completion)));
        Object.assign(h.provider.service, { rewindConversation: replace });
      }
      await Effect.runPromise(
        h.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("revert"),
          threadId,
          turnCount,
          createdAt: at,
        }),
      );
      await waitForThread(h.engine, (thread) =>
        thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
      );
      expect(h.provider.rewindInputs).toHaveLength(0);
      expect(h.provider.rollbackConversation).not.toHaveBeenCalled();
      const thread = (await Effect.runPromise(h.engine.getReadModel())).threads[0]!;
      expect(thread.checkpoints).toHaveLength(2);
      if (replaceRepository)
        expect(
          await Effect.runPromise(
            h.checkpointStore.hasCheckpointRef({
              cwd: h.cwd,
              checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
              exactRef: true,
            }),
          ),
        ).toBe(true);
    },
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readManagedProviderAttachment } from "../../attachments/providerAttachments.managed.ts";
import { ServerConfig } from "../../startup/config.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "../Normalizer.ts";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const at = "2026-11-23T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("held-queue-thread");
const messageId = MessageId.makeUnsafe("held-message");
const projectId = ProjectId.makeUnsafe("held-queue-project");
const claim = {
  type: "thread.queued-prompt.claim",
  threadId,
  messageId,
  commandId: CommandId.makeUnsafe("held-queue-claim"),
  createdAt: at,
  promptCreatedAt: at,
  alreadySent: false,
} satisfies OrchestrationCommand;

it("atomically claims a still-held occurrence and replays only that claim after restart", () =>
  withDatabase("held-queue-claim-", async (database) => {
    const first = createRuntime(database);
    let sequence: number;
    try {
      const engine = await engineFor(first);
      for (const command of createCommands(projectId, [threadId])) {
        await first.runPromise(engine.dispatch(command));
      }
      await first.runPromise(
        engine.dispatch({
          type: "thread.message.submit",
          commandId: CommandId.makeUnsafe("held-submit"),
          threadId,
          message: { messageId, text: "do not send" },
          delivery: "queue",
          createdAt: at,
        }),
      );
      await expect(
        first.runPromise(
          engine.dispatch({
            ...claim,
            commandId: CommandId.makeUnsafe("not-yet-held"),
          }),
        ),
      ).rejects.toMatchObject({ code: "queue_stale_selection" });
      await first.runPromise(
        engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("hold-queue"),
          threadId,
          createdAt: at,
        }),
      );
      await expect(
        first.runPromise(
          engine.dispatch({
            ...claim,
            commandId: CommandId.makeUnsafe("wrong-occurrence"),
            promptCreatedAt: "2026-11-22T12:00:00.000Z",
          }),
        ),
      ).rejects.toMatchObject({ code: "queue_stale_selection" });
      ({ sequence } = await first.runPromise(engine.dispatch(claim)));
      await expect(
        first.runPromise(
          engine.dispatch({
            ...claim,
            commandId: CommandId.makeUnsafe("competing-claim"),
          }),
        ),
      ).rejects.toMatchObject({ code: "queue_stale_selection" });
    } finally {
      await first.dispose();
    }
    const restarted = createRuntime(database);
    try {
      const engine = await engineFor(restarted);
      await expect(
        restarted.runPromise(engine.getCommandOutcome!(claim.commandId)),
      ).resolves.toMatchObject({
        status: "accepted",
        resultSequence: sequence,
      });
      await expect(restarted.runPromise(engine.dispatch(claim))).resolves.toEqual({ sequence });
      const events = Array.from(
        await restarted.runPromise(Stream.runCollect(engine.readEvents(0))),
      );
      expect(events.filter((event) => event.type === "thread.queued-prompt-removed")).toHaveLength(
        1,
      );
      expect(events.some((event) => event.type === "thread.message-sent")).toBe(false);
    } finally {
      await restarted.dispose();
    }
  }));

const send = {
  type: "thread.queued-prompt.recovered",
  action: "send",
  claimId: claim.commandId,
  commandId: CommandId.makeUnsafe("send-recovered"),
  threadId,
  createdAt: at,
} satisfies OrchestrationCommand;

it.each([false, true])("sends a recovered desktop attachment with older held work = %s", (older) =>
  withDatabase("held-queue-send-", async (database) => {
    const runtime = createRuntime(database);
    try {
      const engine = await engineFor(runtime);
      const dispatch = (command: OrchestrationCommand) =>
        runtime.runPromise(engine.dispatch(command));
      for (const command of createCommands(projectId, [threadId])) await dispatch(command);
      await dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("hold"),
        threadId,
        createdAt: at,
      });
      const earlier = MessageId.makeUnsafe("earlier-held");
      if (older)
        await dispatch({
          type: "thread.message.submit",
          commandId: CommandId.makeUnsafe("earlier-submit"),
          threadId,
          message: { messageId: earlier, text: "first" },
          delivery: "queue",
          createdAt: at,
        });
      const root = dirname(database);
      const desktopPath = join(root, "original.txt");
      await writeFile(desktopPath, "snapshot");
      const fixture = Layer.empty.pipe(
        Layer.provideMerge(WorkspacePathsLive),
        Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "held-desktop-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { attachmentsDir } = yield* ServerConfig;
            const normalized = yield* normalizeDispatchCommand({
              type: "thread.message.submit",
              commandId: CommandId.makeUnsafe("queue-desktop"),
              threadId,
              message: {
                messageId,
                text: "original text",
                attachments: [
                  {
                    type: "file",
                    transport: "path",
                    filePath: desktopPath,
                    name: "original.txt",
                    mimeType: "text/plain",
                    sizeBytes: 8,
                  },
                ],
              },
              delivery: "queue",
              createdAt: at,
            });
            if (normalized.type !== "thread.message.submit")
              throw new Error("Missing normalized submission");
            const attachment = normalized.message.attachments?.[0];
            expect(attachment).toMatchObject({ type: "file", sourcePath: desktopPath });
            if (!attachment) throw new Error("Missing normalized attachment");
            yield* Effect.promise(() => dispatch(normalized));
            yield* Effect.promise(() => dispatch(claim));
            const holds = yield* Effect.promise(() =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  return yield* sql`SELECT attachment_id FROM recovered_queue_draft_attachments WHERE claim_id = ${claim.commandId}`;
                }),
              ),
            );
            expect(holds).toEqual([{ attachment_id: attachment.id }]);
            yield* Effect.promise(() => writeFile(desktopPath, "changed"));
            yield* Effect.promise(async () => {
              const receipt = await dispatch(send);
              await expect(dispatch(send)).resolves.toEqual(receipt);
              await expect(
                dispatch({ ...send, commandId: CommandId.makeUnsafe("duplicate-send") }),
              ).rejects.toMatchObject({ code: "queue_stale_selection" });
            });
            const model = yield* Effect.promise(() => runtime.runPromise(engine.getReadModel()));
            const thread = model.threads.find((item) => item.id === threadId);
            expect(thread?.queueHold).toBe(older);
            const [projection] = yield* Effect.promise(() =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  return yield* sql<{
                    held: number;
                  }>`SELECT queue_hold AS held FROM projection_threads WHERE thread_id = ${threadId}`;
                }),
              ),
            );
            expect(projection?.held).toBe(older ? 1 : 0);

            if (older) {
              expect(thread?.queuedPrompts?.map((prompt) => prompt.text)).toEqual([
                "first",
                "original text",
              ]);
              expect(thread?.queuedPrompts?.[0]?.id).toBe(earlier);
              expect(thread?.queuedPrompts?.[1]?.attachments).toMatchObject([attachment]);
              expect(thread?.messages).toEqual([]);
            } else {
              expect(thread?.queuedPrompts).toEqual([]);
              expect(thread?.messages).toMatchObject([
                { text: "original text", attachments: [attachment] },
              ]);
              expect(thread?.pendingTurnStart).not.toBeNull();
            }
            const prepared = yield* Effect.promise(() =>
              readManagedProviderAttachment(attachment, attachmentsDir),
            );
            expect(prepared.bytes.toString()).toBe("snapshot");
            expect(prepared.path).not.toBe(desktopPath);
          }).pipe(Effect.provide(fixture)),
        ),
      );
    } finally {
      await runtime.dispose();
    }
  }),
);

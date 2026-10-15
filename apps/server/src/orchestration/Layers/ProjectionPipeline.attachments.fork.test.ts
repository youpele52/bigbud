import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../startup/config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  exists,
  makeProjectionPipelinePrefixedTestLayer,
} from "./ProjectionPipeline.test.helpers.ts";

const PROJECT = ProjectId.makeUnsafe("project-fork-files");
const SOURCE = ThreadId.makeUnsafe("source-files");
const FORK = ThreadId.makeUnsafe("fork-files");
const NOW = "2026-10-15T10:00:00.000Z";
const ids = {
  kept: "source-files-00000000-0000-4000-8000-000000000001",
  forkMessage: "source-files-00000000-0000-4000-8000-000000000002",
  forkQueued: "source-files-00000000-0000-4000-8000-000000000003",
  unreferenced: "source-files-00000000-0000-4000-8000-000000000004",
};
const image = (id: string) => ({
  type: "image" as const,
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 4,
});

let sequence = 0;
const event = (type: OrchestrationEvent["type"], aggregateId: string, payload: unknown) => {
  sequence += 1;
  return {
    type,
    eventId: EventId.makeUnsafe(`evt-fork-files-${sequence}`),
    aggregateKind: type.startsWith("project.") ? "project" : "thread",
    aggregateId,
    occurredAt: NOW,
    commandId: CommandId.makeUnsafe(`cmd-fork-files-${sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.makeUnsafe(`cmd-fork-files-${sequence}`),
    metadata: {},
    payload,
  } as never;
};

const thread = (threadId: ThreadId, extra: object = {}) =>
  event("thread.created", threadId, {
    threadId,
    projectId: PROJECT,
    title: "Fork files",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  });

const turn = (count: number, messageId: string, attachmentIds: string[]) => [
  event("thread.turn-diff-completed", SOURCE, {
    threadId: SOURCE,
    turnId: TurnId.makeUnsafe(`turn-${count}`),
    checkpointTurnCount: count,
    checkpointRef: CheckpointRef.makeUnsafe(`refs/t3/checkpoints/source-files/turn/${count}`),
    status: "ready",
    files: [],
    assistantMessageId: MessageId.makeUnsafe(messageId),
    completedAt: NOW,
  }),
  event("thread.message-sent", SOURCE, {
    threadId: SOURCE,
    messageId: MessageId.makeUnsafe(messageId),
    role: "assistant",
    text: messageId,
    attachments: attachmentIds.map(image),
    turnId: TurnId.makeUnsafe(`turn-${count}`),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  }),
];

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("bigbud-projection-fork-files-")))(
  "attachment pruning with server-side forks",
  (it) => {
    it.effect("a source revert keeps files that a fork still references", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const { attachmentsDir } = yield* ServerConfig;
        const project = (input: never) =>
          eventStore.append(input).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));

        yield* project(
          event("project.created", PROJECT, {
            projectId: PROJECT,
            title: "Fork files",
            workspaceRoot: "/tmp/project-fork-files",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
          }),
        );
        yield* project(thread(SOURCE));
        for (const entry of [
          ...turn(1, "message-1", [ids.kept]),
          ...turn(2, "message-2", [ids.forkMessage, ids.forkQueued, ids.unreferenced]),
        ]) {
          yield* project(entry);
        }
        yield* project(
          thread(FORK, {
            parentThread: { threadId: SOURCE, title: "Fork files", projectId: PROJECT },
            forkOrigin: {
              forkPointMessageId: "message-2",
              reason: "manual",
              failureEventId: null,
              pendingDelivery: "held",
            },
          }),
        );
        yield* project(
          event("thread.message-sent", FORK, {
            threadId: FORK,
            messageId: MessageId.makeUnsafe("fork-message"),
            role: "assistant",
            text: "copied",
            attachments: [image(ids.forkMessage)],
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        );
        yield* project(
          event("thread.prompt-queued", FORK, {
            threadId: FORK,
            prompt: {
              id: "fork-pending",
              text: "held",
              createdAt: NOW,
              attachments: [image(ids.forkQueued)],
            },
            queuePosition: 1,
          }),
        );

        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        const filePath = (id: string) => path.join(attachmentsDir, `${id}.png`);
        for (const id of Object.values(ids)) yield* fileSystem.writeFileString(filePath(id), id);

        yield* project(event("thread.reverted", SOURCE, { threadId: SOURCE, turnCount: 1 }));

        assert.isTrue(yield* exists(filePath(ids.kept)));
        assert.isTrue(yield* exists(filePath(ids.forkMessage)));
        assert.isTrue(yield* exists(filePath(ids.forkQueued)));
        assert.isFalse(yield* exists(filePath(ids.unreferenced)));
      }),
    );
  },
);

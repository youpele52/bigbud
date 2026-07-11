import { CommandId, CorrelationId, EventId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { resolveProjectMemoryDirectoryPath } from "../../learning/Layers/MemoryStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../startup/config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  exists,
  makeProjectionPipelinePrefixedTestLayer,
} from "./ProjectionPipeline.test.helpers.ts";

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("bigbud-project-memory-delete-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("removes project memory only after project deletion is finalized", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const { stateDir } = yield* ServerConfig;
        const projectId = ProjectId.makeUnsafe("project-memory-delete");
        const now = new Date().toISOString();
        const memoryDirectory = resolveProjectMemoryDirectoryPath({
          path,
          stateDir,
          projectId,
        });
        assert.isNotNull(memoryDirectory);
        const memoryPath = path.join(memoryDirectory!, "MEMORY.md");

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-project-memory-created"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-project-memory-created"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-project-memory-created"),
          metadata: {},
          payload: {
            projectId,
            title: "Project Memory Delete",
            workspaceRoot: "/tmp/project-memory-delete",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* fileSystem.makeDirectory(memoryDirectory!, { recursive: true });
        yield* fileSystem.writeFileString(memoryPath, "# Project memory\n");

        yield* appendAndProject({
          type: "project.deletion-requested",
          eventId: EventId.makeUnsafe("evt-project-memory-delete-requested"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-project-memory-delete-requested"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-project-memory-delete-requested"),
          metadata: {},
          payload: { projectId, deletingAt: now },
        });
        assert.isTrue(yield* exists(memoryPath));

        yield* appendAndProject({
          type: "project.deletion-failed",
          eventId: EventId.makeUnsafe("evt-project-memory-delete-failed"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-project-memory-delete-failed"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-project-memory-delete-failed"),
          metadata: {},
          payload: { projectId, updatedAt: now },
        });
        assert.isTrue(yield* exists(memoryPath));

        yield* appendAndProject({
          type: "project.deleted",
          eventId: EventId.makeUnsafe("evt-project-memory-deleted"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-project-memory-deleted"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-project-memory-deleted"),
          metadata: {},
          payload: { projectId, deletedAt: now },
        });

        assert.isFalse(yield* exists(memoryDirectory!));
      }),
    );
  },
);

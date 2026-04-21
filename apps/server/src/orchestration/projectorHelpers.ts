/**
 * Projector helpers and project-event cases.
 *
 * Contains pure helper functions shared across projector modules plus
 * the `project.created`, `project.meta-updated`, and `project.deleted`
 * event handlers.
 */
import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@bigbud/contracts";
import { OrchestrationThread } from "@bigbud/contracts";
import { Effect, Schema } from "effect";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
} from "./Schemas.ts";

// ─── Shared helpers ─────────────────────────────────────────────────────────

export type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;

export function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

export function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

export function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

// ─── Project event cases ─────────────────────────────────────────────────────

export function projectProjectCreated(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "project.created" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => {
      const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
      const nextProject = {
        id: payload.projectId,
        title: payload.title,
        workspaceRoot: payload.workspaceRoot,
        defaultModelSelection: payload.defaultModelSelection,
        scripts: payload.scripts,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        deletedAt: null,
      };

      return {
        ...nextBase,
        projects: existing
          ? nextBase.projects.map((entry) => (entry.id === payload.projectId ? nextProject : entry))
          : [...nextBase.projects, nextProject],
      };
    }),
  );
}

export function projectProjectMetaUpdated(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "project.meta-updated" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      projects: nextBase.projects.map((project) =>
        project.id === payload.projectId
          ? {
              ...project,
              ...(payload.title !== undefined ? { title: payload.title } : {}),
              ...(payload.workspaceRoot !== undefined
                ? { workspaceRoot: payload.workspaceRoot }
                : {}),
              ...(payload.defaultModelSelection !== undefined
                ? { defaultModelSelection: payload.defaultModelSelection }
                : {}),
              ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
              updatedAt: payload.updatedAt,
            }
          : project,
      ),
    })),
  );
}

export function projectProjectDeleted(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "project.deleted" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
    // oxlint-disable-next-line no-map-spread -- copy-on-write required for immutable read model
    Effect.map((payload) => ({
      ...nextBase,
      projects: nextBase.projects.map((project) =>
        project.id === payload.projectId
          ? {
              ...project,
              deletedAt: payload.deletedAt,
              updatedAt: payload.deletedAt,
            }
          : project,
      ),
    })),
  );
}

import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import { hasTextGenerationRequestStage } from "../../git/Layers/InternalTextGeneration.requests.ts";
import { makeLegacyMetadataAdmission } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.admission.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";
import { makeTextGenerationActivityHandler } from "./ProviderCommandReactorHandlers.textGeneration.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import type {
  MetadataSummaryRequest,
  MetadataTitleRequest,
} from "./ThreadMetadataGeneration.requests.ts";

describe("stale metadata retry bookkeeping", () => {
  it.each(
    (["title", "summary"] as const).flatMap((operation) =>
      (["workspace", "title"] as const).map((change) => ({ operation, change })),
    ),
  )(
    "does not fence later $operation admission after a stale $change retry",
    ({ operation, change }) =>
      withDatabase("bigbud-stale-metadata-retry-", async (dbPath) => {
        const threadId = ThreadId.makeUnsafe("stale-retry");
        const runtime = createRuntime(dbPath);
        try {
          const engine = await engineFor(runtime);
          for (const command of createCommands(ProjectId.makeUnsafe("retry-project"), [threadId])) {
            await runtime.runPromise(
              engine.dispatch(
                command.type === "project.create" ? { ...command, workspaceRoot: "/tmp" } : command,
              ),
            );
          }
          await runtime.runPromise(
            engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe("first-user"),
              threadId,
              message: {
                messageId: MessageId.makeUnsafe("first-user"),
                role: "user",
                text: "Recover thread metadata",
                attachments: [],
              },
              runtimeMode: "approval-required",
              interactionMode: "default",
              createdAt: new Date().toISOString(),
            }),
          );
          await runtime.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const settings = yield* ServerSettingsService;
                const resolveThread = () =>
                  engine
                    .getReadModel()
                    .pipe(
                      Effect.map((model) => model.threads.find((thread) => thread.id === threadId)),
                    );
                const thread = (yield* resolveThread())!;
                const title = vi.fn((_request: MetadataTitleRequest) => Effect.void);
                const summary = vi.fn((_request: MetadataSummaryRequest) => Effect.void);
                const services = {
                  orchestrationEngine: engine,
                  serverSettingsService: settings,
                  resolveThread,
                  metadataGeneration: { title, summary, start: () => Effect.void },
                } as unknown as SessionOpServices;
                const handle = yield* makeTextGenerationActivityHandler(services);
                const context = {
                  cwd: "/tmp",
                  workspaceExecutionTargetId: "local",
                  projectId: thread.projectId,
                  branch: thread.branch,
                  worktreePath: thread.worktreePath,
                  title: thread.title,
                };
                const request = (id: string, stale: boolean): OrchestrationThreadActivity => ({
                  id: EventId.makeUnsafe(id),
                  kind: "text-generation.retry-requested",
                  tone: "info",
                  summary: "Retry metadata generation",
                  payload: {
                    operation,
                    requestId: id,
                    sourceActivityId: "durable-failure",
                    context: {
                      ...context,
                      ...(stale && change === "workspace" ? { cwd: "/previous-workspace" } : {}),
                      ...(stale && change === "title" ? { title: "Previous title" } : {}),
                    },
                  },
                  turnId: null,
                  createdAt: new Date().toISOString(),
                });
                const deliver = Effect.fn("test.deliverRetry")(function* (
                  activity: OrchestrationThreadActivity,
                ) {
                  yield* engine.dispatch({
                    type: "thread.activity.append",
                    commandId: CommandId.makeUnsafe(`request:${activity.id}`),
                    threadId,
                    activity,
                    createdAt: activity.createdAt,
                  });
                  yield* handle({ payload: { threadId, activity } });
                  for (let tick = 0; tick < 100; tick++) {
                    const current = (yield* resolveThread())!;
                    if (hasTextGenerationRequestStage(current.activities, activity.id, "settled"))
                      return;
                    yield* Effect.sleep("10 millis");
                  }
                  return yield* Effect.die("Retry bookkeeping did not settle");
                });
                yield* deliver(request("stale-request", true));
                expect(title).not.toHaveBeenCalled();
                expect(summary).not.toHaveBeenCalled();
                const afterDiscard = (yield* resolveThread())!;
                expect(
                  afterDiscard.activities.some((activity) =>
                    ["text-generation.completed", "text-generation.started"].includes(
                      activity.kind,
                    ),
                  ),
                ).toBe(false);
                const admission = yield* makeLegacyMetadataAdmission();
                expect(yield* admission({ threadId, operation })).toMatchObject({ allowed: true });
                yield* deliver(request("current-request", false));
                const admitted = operation === "title" ? title : summary;
                expect(admitted).toHaveBeenCalledTimes(1);
                expect(admitted.mock.calls[0]?.[0]).toMatchObject({
                  threadId,
                  retryKey: "current-request",
                });
              }),
            ),
          );
        } finally {
          await runtime.dispose();
        }
        // Reopen the real SQL runtime: bookkeeping must not become a paid-work fence on restart.
        const restarted = createRuntime(dbPath);
        try {
          await engineFor(restarted);
          const result = await restarted.runPromise(
            Effect.gen(function* () {
              const admission = yield* makeLegacyMetadataAdmission();
              return yield* admission({ threadId, operation });
            }),
          );
          expect(result).toMatchObject({ allowed: true });
        } finally {
          await restarted.dispose();
        }
      }),
  );
});

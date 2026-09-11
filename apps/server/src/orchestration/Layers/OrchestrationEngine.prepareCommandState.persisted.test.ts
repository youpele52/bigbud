import { CommandId, MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionOperationalStateQuery } from "../Services/ProjectionOperationalStateQuery.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";
import { makeThreadStateHydrator } from "./OrchestrationEngine.hydration.ts";
import { makePrepareCommandState } from "./OrchestrationEngine.prepareCommandState.ts";
import { ProjectionOperationalStateQueryLive } from "./ProjectionOperationalStateQuery.ts";

const now = "2026-09-11T00:00:00.000Z";
const targetId = ThreadId.makeUnsafe("target");
const sourceId = ThreadId.makeUnsafe("source");
type Submit = Extract<OrchestrationCommand, { type: "thread.message.submit" }>;
const submit = (overrides: Partial<Submit> = {}): Submit => ({
  type: "thread.message.submit",
  commandId: CommandId.makeUnsafe("submit"),
  threadId: targetId,
  message: { messageId: MessageId.makeUnsafe("new-message"), text: "continue" },
  delivery: "auto",
  createdAt: now,
  ...overrides,
});

const persistedLayer = Layer.mergeAll(
  ProjectionOperationalStateQueryLive,
  OrchestrationEventStoreLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const seedProjection = Effect.fn("seedColdSubmissionProjection")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const projectId of ["project", "other-project"]) {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, ${projectId}, '/tmp/cold-submit',
        '{"provider":"codex","model":"gpt-5.4"}', '[]', ${now}, ${now}, NULL
      )
    `;
  }
  for (const id of ["target", "source", "foreign", "unrelated"]) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${id}, ${id === "foreign" ? "other-project" : "project"}, ${id},
        '{"provider":"codex","model":"gpt-5.4"}', ${now}, ${now}, NULL
      )
    `;
    yield* sql`
      WITH RECURSIVE counter(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 60
      )
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      SELECT ${id} || '-message-' || printf('%03d', value), ${id}, NULL,
        CASE value WHEN 1 THEN 'user' WHEN 4 THEN 'system' ELSE 'assistant' END,
        ${id} || ' persisted message ' || value, CASE value WHEN 3 THEN 1 ELSE 0 END,
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || value || ' seconds'),
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || value || ' seconds')
      FROM counter
    `;
    yield* sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at
      ) VALUES (${"plan-" + id}, ${id}, NULL, ${"# Persisted " + id}, ${now}, ${now})
    `;
  }
});

const makeFixture = Effect.gen(function* () {
  yield* seedProjection();
  const liveQuery = yield* ProjectionOperationalStateQuery;
  const eventStore = yield* OrchestrationEventStore;
  // SQL rows are the only history source: there are no replay events or warm thread objects.
  expect((yield* eventStore.readReplay(0)).events).toEqual([]);
  const operational = yield* liveQuery.getThreadOperationalState(targetId);
  expect(Option.isSome(operational)).toBe(true);
  const boundedTarget = Option.getOrThrow(operational).threads[0]!;
  expect(boundedTarget.messages).toHaveLength(50);
  expect(boundedTarget.messages[0]?.id).toBe("target-message-011");
  expect(boundedTarget.proposedPlans).toEqual([]);

  const query = {
    getStartupOperationalState: vi.fn(liveQuery.getStartupOperationalState),
    getThreadOperationalState: vi.fn(liveQuery.getThreadOperationalState),
    getFullThreadHistory: vi.fn(liveQuery.getFullThreadHistory),
  };
  let readModel = createEmptyReadModel(now);
  const hydrator = makeThreadStateHydrator({
    query,
    eventStore,
    readModel: () => readModel,
    install: ({ threadId, thread, project }) => {
      readModel = {
        ...readModel,
        threads: [
          ...readModel.threads.filter((entry) => entry.id !== threadId),
          ...(thread ? [thread] : []),
        ],
        projects: project
          ? [...readModel.projects.filter((entry) => entry.id !== project.id), project]
          : readModel.projects,
      };
    },
  });
  const load = vi.fn(hydrator.load);
  const prepare = makePrepareCommandState({ threadStateHydrator: { load } });
  expect(readModel.threads).toEqual([]);
  return {
    query,
    load,
    prepare,
    readModel: () => readModel,
    decide: (command: Submit) =>
      Effect.suspend(() => decideOrchestrationCommand({ command, readModel })),
  };
});

type Fixture = Effect.Success<typeof makeFixture>;
function withFixture<E>(test: (fixture: Fixture) => Effect.Effect<void, E>) {
  // Each test builds a fresh SQLite database and a fresh, empty hydrator cache.
  return Effect.runPromise(Effect.flatMap(makeFixture, test).pipe(Effect.provide(persistedLayer)));
}

function expectStarted(events: unknown, startPayload: object = {}, messagePayload: object = {}) {
  expect(events).toMatchObject([
    {
      type: "thread.message-sent",
      commandId: "submit",
      payload: { threadId: targetId, messageId: "new-message", ...messagePayload },
    },
    {
      type: "thread.turn-start-requested",
      commandId: "submit",
      payload: { threadId: targetId, messageId: "new-message", ...startPayload },
    },
  ]);
}

describe("prepareCommandState with cold SQL projection history", () => {
  it("starts plain submissions with only the target's recent 50, without global/history loading", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const command = submit();
        yield* fixture.prepare(command);
        expectStarted(yield* fixture.decide(command));
        expect(fixture.readModel().threads.map((thread) => thread.id)).toEqual([targetId]);
        expect(fixture.readModel().projects.map((project) => project.id)).toEqual(["project"]);
        const target = fixture.readModel().threads[0]!;
        expect(target.messages).toHaveLength(50);
        expect(target.messages[0]?.id).toBe("target-message-011");
        expect(target.messages.at(-1)?.id).toBe("target-message-060");
        expect(target.proposedPlans).toEqual([]);
        expect(fixture.load.mock.calls).toEqual([[targetId, "operational"]]);
        expect(fixture.query.getThreadOperationalState.mock.calls).toEqual([[targetId]]);
        expect(fixture.query.getFullThreadHistory).not.toHaveBeenCalled();
        expect(fixture.query.getStartupOperationalState).not.toHaveBeenCalled();
      }),
    ));

  it.each([
    ["001", "user", 1],
    ["002", "assistant", 2],
  ] as const)(
    "accepts old %s %s replies absent from the operational window",
    (suffix, role, value) =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const replyToMessageId = MessageId.makeUnsafe(`target-message-${suffix}`);
          const command = submit({ message: { ...submit().message, replyToMessageId } });
          yield* fixture.prepare(command);
          const replyTo = {
            messageId: replyToMessageId,
            role,
            excerpt: `target persisted message ${value}`,
            createdAt: `2026-01-01T00:00:${suffix.slice(1)}.000Z`,
          };
          expectStarted(yield* fixture.decide(command), { replyTo }, { replyTo });
          expect(fixture.readModel().threads[0]?.messages).toHaveLength(60);
          expect(fixture.load.mock.calls).toEqual([[targetId, "history"]]);
          expect(fixture.query.getThreadOperationalState).not.toHaveBeenCalled();
          expect(fixture.query.getFullThreadHistory.mock.calls).toEqual([[targetId]]);
        }),
      ),
  );

  it("accepts a persisted source plan without hydrating the target's full history", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const sourceProposedPlan = { threadId: sourceId, planId: "plan-source" };
        const command = submit({ sourceProposedPlan });
        yield* fixture.prepare(command);
        expectStarted(yield* fixture.decide(command), { sourceProposedPlan });
        expect(fixture.readModel().threads.map((thread) => thread.id)).toEqual([
          targetId,
          sourceId,
        ]);
        const [target, source] = fixture.readModel().threads;
        expect(target?.messages).toHaveLength(50);
        expect(target?.proposedPlans).toEqual([]);
        expect(source?.messages).toHaveLength(60);
        expect(source?.proposedPlans).toMatchObject([
          { id: "plan-source", planMarkdown: "# Persisted source" },
        ]);
        expect(fixture.query.getThreadOperationalState.mock.calls).toEqual([[targetId]]);
        expect(fixture.query.getFullThreadHistory.mock.calls).toEqual([[sourceId]]);
      }),
    ));

  it.each([false, true])("hydrates a same-thread plan once (with reply: %s)", (withReply) =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const sourceProposedPlan = { threadId: targetId, planId: "plan-target" };
        const command = submit({
          sourceProposedPlan,
          message: {
            ...submit().message,
            ...(withReply ? { replyToMessageId: MessageId.makeUnsafe("target-message-001") } : {}),
          },
        });
        yield* fixture.prepare(command);
        expectStarted(yield* fixture.decide(command), {
          sourceProposedPlan,
          ...(withReply ? { replyTo: { messageId: "target-message-001" } } : {}),
        });
        expect(fixture.readModel().threads).toHaveLength(1);
        expect(fixture.readModel().threads[0]?.messages).toHaveLength(60);
        // Assert load calls too: the hydrator's cache must not hide redundant preparation.
        expect(fixture.load.mock.calls).toEqual([[targetId, "history"]]);
        expect(fixture.query.getFullThreadHistory.mock.calls).toEqual([[targetId]]);
        expect(fixture.query.getThreadOperationalState).not.toHaveBeenCalled();
      }),
    ),
  );

  it.each([
    ["source", "missing-plan", "does not exist on thread 'source'"],
    ["missing-thread", "plan-source", "does not exist"],
    ["foreign", "plan-foreign", "in a different project"],
  ])("rejects persisted plan reference %s/%s through the decider", (thread, planId, detail) =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(thread);
        const command = submit({ sourceProposedPlan: { threadId, planId } });
        yield* fixture.prepare(command);
        const error = yield* Effect.flip(fixture.decide(command));
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        expect(error.detail).toContain(detail);
        if (thread === "foreign") {
          const foreign = fixture.readModel().threads.find((entry) => entry.id === threadId);
          expect(foreign?.projectId).toBe("other-project");
          expect(foreign?.proposedPlans).toMatchObject([{ id: planId }]);
        }
        expect(fixture.query.getFullThreadHistory.mock.calls).toEqual([[threadId]]);
        expect(fixture.query.getThreadOperationalState.mock.calls).toEqual([[targetId]]);
      }),
    ),
  );

  it.each([
    ["003", "is still streaming"],
    ["004", "cannot reference a system message"],
    ["missing", "does not exist on thread 'target'"],
  ])("rejects old reply %s after real history hydration", (suffix, detail) =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const command = submit({
          message: {
            ...submit().message,
            replyToMessageId: MessageId.makeUnsafe(`target-message-${suffix}`),
          },
        });
        yield* fixture.prepare(command);
        expect(fixture.readModel().threads[0]?.messages).toHaveLength(60);
        const error = yield* Effect.flip(fixture.decide(command));
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        expect(error.detail).toContain(detail);
        expect(fixture.query.getFullThreadHistory.mock.calls).toEqual([[targetId]]);
      }),
    ),
  );
});

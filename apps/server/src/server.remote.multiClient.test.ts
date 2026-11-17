/**
 * WP-3D: two clients on one remote backend. Each client is a real authenticated `/ws` RPC
 * connection to the remote client surface; both share one real engine, receipt store and
 * projection pipeline. Provider runtimes are absent: where a provider would act, the test
 * dispatches the canonical command the provider ingestion path produces.
 */
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { serverTestLayer, withWsRpcClient, type WsRpcClient } from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import { makeRemoteBackendUnderTest, remoteWsUrl } from "./server.test.remote.ts";

const createdAt = "2026-11-17T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("project-remote-multi-client");

const projectCreate = {
  type: "project.create",
  commandId: CommandId.makeUnsafe("cmd-remote-project"),
  projectId,
  title: "Remote",
  workspaceRoot: null,
  defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
  createdAt,
} as const;

const threadCreate = (id: string, title = `Thread ${id}`) =>
  ({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`cmd-create-${id}`),
    threadId: ThreadId.makeUnsafe(id),
    projectId,
    title,
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt,
  }) as const;

const failureText = (exit: { readonly _tag: string }) => JSON.stringify(exit);

const countEvents = (events: ReadonlyArray<OrchestrationEvent>, type: OrchestrationEvent["type"]) =>
  events.filter((event) => event.type === type).length;

type Titles = Record<string, string>;
/** The thread titles a client would render, folded from canonical events. */
const applyEvent = (titles: Titles, event: OrchestrationEvent): Titles => {
  if (event.type === "thread.created")
    return { ...titles, [event.payload.threadId]: event.payload.title };
  if (
    event.type === "thread.meta-updated" &&
    event.payload.title !== undefined &&
    event.payload.threadId in titles
  )
    return { ...titles, [event.payload.threadId]: event.payload.title };
  if (event.type === "thread.deleted") {
    const { [event.payload.threadId]: _removed, ...rest } = titles;
    return rest;
  }
  return titles;
};
const fromCatalog = (threads: ReadonlyArray<{ id: string; title: string }>): Titles =>
  Object.fromEntries(threads.map((thread) => [thread.id, thread.title]));
const sequences = (events: ReadonlyArray<OrchestrationEvent>) =>
  events.map((event) => event.sequence);

it.layer(serverTestLayer)("remote backend > multiple clients", (it) => {
  it.effect("two_clients_same_command_id_one_receipt", () =>
    Effect.gen(function* () {
      const backend = yield* makeRemoteBackendUnderTest();
      yield* backend.engine.dispatch(projectCreate);
      const command = threadCreate("thread-shared");
      const url = yield* remoteWsUrl();

      const outcome = yield* withWsRpcClient(url, (clientA) =>
        withWsRpcClient(url, (clientB) =>
          Effect.gen(function* () {
            // Both laptops send the same command at once, e.g. a shared retry after a lost reply.
            const [fromA, fromB] = yield* Effect.all(
              [
                clientA[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
                clientB[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
              ],
              { concurrency: "unbounded" },
            );
            const recorded = yield* clientB[ORCHESTRATION_WS_METHODS.getCommandOutcome]({
              commandId: command.commandId,
            });
            const reused = yield* clientB[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              ...command,
              title: "A different payload under the same id",
            }).pipe(Effect.exit);
            return { fromA, fromB, recorded, reused };
          }),
        ),
      );

      assert.deepStrictEqual(outcome.fromA, outcome.fromB);
      assert.include(outcome.recorded, {
        status: "accepted",
        resultSequence: outcome.fromA.sequence,
      });
      assert.equal(outcome.reused._tag, "Failure");
      assert.include(failureText(outcome.reused), "command_id_conflict");
      const replay = yield* backend.engine.readReplay(0);
      assert.equal(countEvents(replay.events, "thread.created"), 1);
      const receipts = yield* backend.sql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM orchestration_command_receipts
            WHERE command_id = ${command.commandId}
          `;
        }),
      );
      assert.equal(receipts[0]?.count, 1);
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );

  it.effect("approval_answered_once_second_gets_already_resolved", () =>
    Effect.gen(function* () {
      const backend = yield* makeRemoteBackendUnderTest();
      const create = threadCreate("thread-approval");
      const threadId = create.threadId;
      const requestId = ApprovalRequestId.makeUnsafe("approval-request-shared");
      yield* backend.engine.dispatch(projectCreate);
      yield* backend.engine.dispatch(create);
      yield* backend.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-approval-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
      const appendActivity = (
        kind: "approval.requested" | "approval.resolved",
        at: string,
        extra = {},
      ) =>
        backend.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`cmd-${kind}`),
          threadId,
          activity: {
            id: EventId.makeUnsafe(`activity-${kind}`),
            tone: "approval",
            kind,
            summary: kind,
            payload: { requestId, requestKind: "command", ...extra },
            turnId: null,
            createdAt: at,
          },
          createdAt: at,
        });
      yield* appendActivity("approval.requested", "2026-11-17T00:00:01.000Z");
      const respond = (client: WsRpcClient, id: string, decision: "accept" | "decline") =>
        client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe(id),
          threadId,
          requestId,
          decision,
          createdAt,
        }).pipe(Effect.exit);
      const url = yield* remoteWsUrl();

      const outcome = yield* withWsRpcClient(url, (clientA) =>
        withWsRpcClient(url, (clientB) =>
          Effect.gen(function* () {
            const first = yield* respond(clientA, "cmd-answer-a", "accept");
            // The provider resolves the request; ingestion records it on the thread.
            yield* appendActivity("approval.resolved", "2026-11-17T00:00:02.000Z", {
              decision: "accept",
            });
            const second = yield* respond(clientB, "cmd-answer-b", "decline");
            const resend = yield* respond(clientA, "cmd-answer-a", "accept");
            return { first, second, resend };
          }),
        ),
      );

      assert.equal(outcome.first._tag, "Success");
      assert.deepStrictEqual(outcome.resend, outcome.first);
      assert.equal(outcome.second._tag, "Failure");
      assert.include(failureText(outcome.second), "already resolved");
      const replay = yield* backend.engine.readReplay(0);
      const answers = replay.events.filter(
        (event) => event.type === "thread.approval-response-requested",
      );
      // Exactly one answer intent reaches the provider reactor, carrying the first decision.
      assert.equal(answers.length, 1);
      assert.include(answers[0]?.payload, { decision: "accept" });
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );

  it.effect("fresh_client_snapshot_plus_tail_equals_live", () =>
    Effect.gen(function* () {
      const backend = yield* makeRemoteBackendUnderTest();
      yield* backend.engine.dispatch(projectCreate);
      const url = yield* remoteWsUrl();

      const follow = (
        client: WsRpcClient,
        consumerId: string,
        appliedSequence: number,
        sink: Array<OrchestrationEvent>,
      ) =>
        client[WS_METHODS.subscribeOrchestrationDomainEvents]({ consumerId, appliedSequence }).pipe(
          Stream.runForEach((item) =>
            item.type !== "batch"
              ? Effect.void
              : Effect.gen(function* () {
                  sink.push(...item.events);
                  const through = item.events.at(-1)?.sequence ?? appliedSequence;
                  yield* client[ORCHESTRATION_WS_METHODS.acknowledgeDelivery]({
                    batchId: item.batchId,
                    consumerId: item.consumerId,
                    consumerGeneration: item.consumerGeneration,
                    receivedThroughSequence: through,
                    appliedThroughSequence: through,
                    applicationDurationMs: 0,
                  });
                }),
          ),
        );
      const reachedSequence = (sink: ReadonlyArray<OrchestrationEvent>, target: number) =>
        Effect.gen(function* () {
          while ((sink.at(-1)?.sequence ?? 0) < target) yield* Effect.sleep("20 millis");
        }).pipe(Effect.timeout("10 seconds"));

      const result = yield* withWsRpcClient(url, (clientA) =>
        Effect.gen(function* () {
          // Laptop A has been connected since before any thread existed.
          const live: Array<OrchestrationEvent> = [];
          const liveFiber = yield* Effect.forkChild(follow(clientA, "live-laptop-a", 0, live));
          for (const id of ["thread-one", "thread-two"]) {
            yield* clientA[ORCHESTRATION_WS_METHODS.dispatchCommand](threadCreate(id));
          }
          const fresh = yield* withWsRpcClient(url, (clientB) =>
            Effect.gen(function* () {
              // Laptop B arrives later: one snapshot, then the tail after its sequence.
              const snapshot = yield* clientB[ORCHESTRATION_WS_METHODS.getProjectThreadSummaries]({
                projectId,
              });
              const tail: Array<OrchestrationEvent> = [];
              const tailFiber = yield* Effect.forkChild(
                follow(clientB, "fresh-laptop-b", snapshot.projectionSequence, tail),
              );
              yield* clientA[ORCHESTRATION_WS_METHODS.dispatchCommand](
                threadCreate("thread-three"),
              );
              const last = yield* clientB[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.meta.update",
                commandId: CommandId.makeUnsafe("cmd-rename-one"),
                threadId: ThreadId.makeUnsafe("thread-one"),
                title: "Renamed from laptop B",
              });
              yield* reachedSequence(tail, last.sequence);
              yield* reachedSequence(live, last.sequence);
              yield* Fiber.interrupt(tailFiber);
              const final = yield* clientB[ORCHESTRATION_WS_METHODS.getProjectThreadSummaries]({
                projectId,
              });
              return { snapshot, tail, final };
            }),
          );
          yield* Fiber.interrupt(liveFiber);
          return { live, ...fresh };
        }),
      );

      const snapshotSequence = result.snapshot.projectionSequence;

      // The live stream has no gaps or duplicates, and the tail is exactly its suffix.
      const liveSequences = sequences(result.live);
      assert.deepStrictEqual(
        liveSequences,
        Array.from({ length: liveSequences.length }, (_, index) => index + 1),
      );
      assert.deepStrictEqual(
        sequences(result.tail),
        liveSequences.filter((sequence) => sequence > snapshotSequence),
      );
      const liveTitles = result.live.reduce(applyEvent, {} as Titles);
      const freshTitles = result.tail.reduce(applyEvent, fromCatalog(result.snapshot.threads));
      assert.deepStrictEqual(freshTitles, liveTitles);
      assert.deepStrictEqual(fromCatalog(result.final.threads), liveTitles);
      assert.equal(liveTitles["thread-one"], "Renamed from laptop B");
      assert.lengthOf(Object.keys(liveTitles), 3);
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});

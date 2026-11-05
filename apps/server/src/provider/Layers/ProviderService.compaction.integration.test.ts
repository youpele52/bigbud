import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderEvent } from "@bigbud/contracts/orchestration/provider.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeCompactionDelivery } from "./ProviderService.compaction.ts";
import { makeThreadOperations } from "./ProviderService.threadOperations.ts";
import { makeProviderControls } from "./ProviderService.controls.ts";
import { coordinateProviderControls } from "./ProviderService.controls.admission.ts";
import { makeRewindConversation } from "./ProviderService.rewind.ts";
import {
  CODEX_REWIND_KEY,
  type ProviderExactRewindInput,
  type ProviderPreparedRewind,
} from "../Services/ProviderRewind.ts";
import { readCodexCompactionProofs } from "../Services/ProviderCompaction.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import {
  codexReliabilityHarness,
  exactRewindInput,
} from "../../codex/codexAppServerManager.reliability.test.helpers.ts";
import { codexProviderControls } from "../../codex/codexAppServerManager.controls.ts";
import {
  compactBlocksWork,
  confirmCodexCompaction,
} from "../../codex/codexAppServerManager.controls.state.ts";
import { handleServerNotification } from "../../codex/codexAppServerManager.handlers.notification.ts";
import {
  prepareCodexRewind,
  revertCodexThread,
  verifyCodexRewind,
} from "../../codex/codexAppServerManager.rewind.ts";
import { mapToRuntimeEvents } from "./Codex/Adapter.stream.handlers.ts";
import type { TurnOps } from "../../codex/codexAppServerManager.turn.ts";

const repositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const layer = ProviderSessionDirectoryLive.pipe(Layer.provideMerge(repositoryLayer));

function exercise(target: 1 | 2) {
  return Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    const test = codexReliabilityHarness();
    let context = test.context;
    const threadId = ThreadId.makeUnsafe(`compact-resume-rewind-${target}`);
    context.session = { ...context.session, threadId };
    context.collabReceiverTurns = new Map();
    test.state.turns[0]!.items = [{ type: "userMessage", id: "u1" }];
    test.state.turns[1]!.items = [{ type: "userMessage", id: "u2" }];
    const base = test.ops.sendRequest;
    const ops = {
      ...test.ops,
      sendRequest: (async (ctx, method, params, timeout, guard) => {
        if (method === "thread/compact/start") {
          assert.isTrue(guard!());
          return {};
        }
        return base(ctx, method, params, timeout);
      }) as TurnOps["sendRequest"],
    };
    const preparedInputs: ProviderExactRewindInput[] = [];
    let markerAtMutation: unknown;
    const registry = {
      getByProvider: () =>
        Effect.succeed({
          controls: (input: Parameters<typeof codexProviderControls>[1]) =>
            Effect.promise(() => codexProviderControls(context, input, ops, () => true)),
          listSessions: () => Effect.succeed([context.session]),
          confirmCompaction: (
            input: Parameters<typeof confirmCodexCompaction>[1],
            persisted: boolean,
          ) => Effect.sync(() => confirmCodexCompaction(context, input, persisted)),
          prepareRewind: (input: ProviderExactRewindInput) =>
            Effect.promise(() => {
              preparedInputs.push(input);
              return prepareCodexRewind(context, input, ops);
            }),
          revertThread: (input: ProviderPreparedRewind) =>
            Effect.gen(function* () {
              const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
              markerAtMutation = (binding.runtimePayload as Record<string, unknown>)[
                CODEX_REWIND_KEY
              ];
              yield* Effect.promise(() => revertCodexThread(context, input, ops));
            }),
          verifyRewind: (input: ProviderPreparedRewind) =>
            Effect.promise(() => verifyCodexRewind(context, input, ops)).pipe(Effect.asVoid),
        }),
    } as unknown as ProviderAdapterRegistryShape;
    yield* directory.upsert({
      threadId,
      provider: "codex",
      resumeCursor: { threadId: "native" },
      runtimePayload: { sessionEpoch: 2 },
    });
    const lease = makeThreadOperations(directory);
    const controls = coordinateProviderControls(
      makeProviderControls(registry, directory, () => Effect.void),
      lease,
    );
    const acknowledged = yield* controls({ threadId, sessionEpoch: 2, action: "compact" });
    assert.equal(acknowledged.compactState, "submitted");
    const events: ProviderEvent[] = [];
    const notify = (method: string, fields: Record<string, unknown>) =>
      handleServerNotification(
        context,
        { method, params: { threadId: "native", turnId: "manual", ...fields } },
        { emitEvent: (event) => events.push(event), updateSession: () => {} },
      );
    notify("turn/started", { turn: { id: "manual" } });
    notify("item/started", { item: { type: "contextCompaction", id: "compact-item" } });
    notify("item/completed", { item: { type: "contextCompaction", id: "compact-item" } });
    test.state.turns.push({
      ...test.state.turns[0]!,
      id: "manual",
      items: [{ type: "contextCompaction", id: "compact-item" }],
    });
    notify("turn/completed", { turn: { id: "manual", status: "completed" } });
    assert.isTrue(compactBlocksWork(context));
    assert.equal(context.manualCompact?.state, "working");
    assert.equal(events.length, 1);
    const publication: string[] = [];
    const deliver = makeCompactionDelivery(registry, directory, lease, (event) =>
      Effect.sync(() => {
        publication.push(event.type);
      }),
    );
    for (const event of mapToRuntimeEvents(events[0]!, threadId)) yield* deliver(event);
    assert.deepEqual(publication, ["thread.state.changed"]);
    assert.equal(
      (yield* controls({ threadId, sessionEpoch: 2, action: "status" })).compactState,
      "completed",
    );
    assert.isFalse(compactBlocksWork(context));

    // Resume a fresh native process/context: no live manualCompact memory survives.
    context = { ...context, session: { ...context.session, sessionEpoch: 3 } };
    delete context.manualCompact;
    yield* directory.upsert({
      threadId,
      provider: "codex",
      status: "stopped",
      runtimePayload: { sessionEpoch: 3 },
    });
    const resumed = Option.getOrThrow(yield* directory.getBinding(threadId));
    assert.deepEqual(readCodexCompactionProofs(resumed.runtimePayload, "native"), {
      manual: "compact-item",
    });
    test.state.turns.push({
      ...test.state.turns[0]!,
      id: "t3",
      items: [
        { type: "userMessage", id: "u3" },
        { type: "contextCompaction", id: "automatic" },
      ],
    });
    const input = {
      ...exactRewindInput,
      threadId,
      sessionEpoch: 3,
      currentTurnCount: 3,
      targetTurnCount: target,
      expectedTurnIds: [TurnId.makeUnsafe("t1"), TurnId.makeUnsafe("t2"), TurnId.makeUnsafe("t3")],
      retainedTurnId: TurnId.makeUnsafe(target === 1 ? "t1" : "t2"),
      firstRemovedTurnId: TurnId.makeUnsafe(target === 1 ? "t2" : "t3"),
    };
    const rewind = makeRewindConversation(registry, directory);
    const completed: string[] = [];
    yield* lease(
      threadId,
      rewind(input, {
        preflight: Effect.void,
        restoreFiles: Effect.sync(() => {
          completed.push("files");
        }),
        completeCanonical: Effect.sync(() => {
          completed.push("canonical");
        }),
      }),
    );
    assert.deepEqual(preparedInputs[0]?.maintenanceTurns, { manual: "compact-item" });
    assert.deepEqual(
      (markerAtMutation as ProviderPreparedRewind).nativeTurnIds,
      ["t1", "t2", "manual", "t3"].map((id) => TurnId.makeUnsafe(id)),
    );
    assert.deepEqual(
      test.state.turns.map((turn) => turn.id),
      target === 1 ? ["t1"] : ["t1", "t2", "manual"],
    );
    assert.deepEqual(completed, ["files", "canonical"]);
    assert.isUndefined(
      (
        Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload as Record<
          string,
          unknown
        >
      )[CODEX_REWIND_KEY],
    );
  });
}

it.layer(layer)("manual compact → durable proof → resume → exact rewind", (it) => {
  it("retains the proven maintenance turn before the first removed canonical boundary", () =>
    exercise(2));
  it("removes proven maintenance after the selected canonical boundary with the discarded suffix", () =>
    exercise(1));
});

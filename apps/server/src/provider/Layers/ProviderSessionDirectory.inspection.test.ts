import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { EventId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import {
  hasPendingInspectionTerminal,
  type InspectionTerminal,
} from "../Services/ProviderInspectionTerminal.ts";
import { makeInspectionDelivery } from "./ProviderService.inspection.delivery.ts";

export const inspectedTerminalRecord: InspectionTerminal = {
  version: 1,
  nativeThreadId: "native",
  items: [],
  terminal: {
    eventId: EventId.makeUnsafe("codex-terminal"),
    threadId: ThreadId.makeUnsafe("journal-owner"),
    turnId: TurnId.makeUnsafe("native-turn"),
    provider: "codex",
    sessionEpoch: 2,
    createdAt: "2026-10-30T00:00:00.000Z",
    type: "turn.completed",
    payload: { state: "completed", recoveryRedelivery: true },
    raw: {
      source: "codex.app-server.notification",
      method: "bigbud.inspectedTerminal",
      payload: {},
    },
  },
  acknowledgements: { ingestion: false, checkpoint: false, recovery: false },
};
const repositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const layer = ProviderSessionDirectoryLive.pipe(Layer.provideMerge(repositoryLayer));

it.layer(layer)("durable inspected-terminal journal", (it) => {
  it("retains replay material through claims, lifecycle replacements, stop/removal, and concurrent consumer acknowledgements", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntimeRepository;
      const threadId = inspectedTerminalRecord.terminal.threadId;
      yield* directory.upsert({
        threadId,
        provider: "codex",
        resumeCursor: { threadId: "native" },
        runtimePayload: { sessionEpoch: 2 },
      });
      const stale = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      yield* directory.storeInspectionTerminal!(inspectedTerminalRecord);
      const delivery = makeInspectionDelivery(directory, () => Effect.void);
      assert.isFalse(yield* delivery.inspectionTerminalReady!(inspectedTerminalRecord.terminal));
      assert.isTrue(
        hasPendingInspectionTerminal(
          Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload,
        ),
      );
      yield* Effect.all(
        [
          repository.upsert(stale),
          directory.acknowledgeInspectionTerminal!(threadId, "codex-terminal", "ingestion"),
          directory.acknowledgeInspectionTerminal!(threadId, "codex-terminal", "checkpoint"),
        ],
        { concurrency: "unbounded" },
      );
      yield* directory.remove(threadId);
      assert.isTrue(
        hasPendingInspectionTerminal(
          Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload,
        ),
      );
      const pending = yield* directory.listInspectionTerminals!();
      assert.equal(pending.length, 1);
      assert.deepEqual(pending[0]!.acknowledgements, {
        ingestion: true,
        checkpoint: true,
        recovery: false,
      });
      assert.isTrue(yield* delivery.inspectionTerminalReady!(inspectedTerminalRecord.terminal));
      assert.isTrue(
        hasPendingInspectionTerminal(
          Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload,
        ),
      );
      yield* directory.storeInspectionTerminal!(inspectedTerminalRecord);
      assert.deepEqual(
        (yield* directory.listInspectionTerminals!())[0]!.acknowledgements,
        pending[0]!.acknowledgements,
      );
      yield* directory.acknowledgeInspectionTerminal!(threadId, "unrelated", "recovery");
      assert.equal((yield* directory.listInspectionTerminals!()).length, 1);
      yield* directory.acknowledgeInspectionTerminal!(threadId, "codex-terminal", "recovery");
      assert.equal((yield* directory.listInspectionTerminals!()).length, 0);
      assert.isFalse(
        hasPendingInspectionTerminal(
          Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload,
        ),
      );
    }));
});

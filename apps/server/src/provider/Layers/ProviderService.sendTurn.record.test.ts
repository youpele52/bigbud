import { ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import type { ProviderTurnLivenessRepositoryShape } from "../../persistence/Services/ProviderTurnLiveness.ts";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { recordAcceptedSendTurn } from "./ProviderService.sendTurn.record.ts";

const threadId = ThreadId.makeUnsafe("record-thread");
const turnId = TurnId.makeUnsafe("record-turn");

function makeHarness() {
  const calls: string[] = [];
  const bindings: ProviderRuntimeBinding[] = [];
  const directory: ProviderSessionDirectoryShape = {
    upsert: (value) =>
      Effect.sync(() => {
        calls.push("binding");
        bindings.push(value);
      }),
    getBinding: () => Effect.succeed(Option.none()),
    getProvider: () => Effect.succeed("codex"),
    remove: () => Effect.void,
    listThreadIds: () => Effect.succeed([]),
    listBindings: () => Effect.succeed([]),
  };
  const liveness = {
    startTurn: () => Effect.sync(() => calls.push("liveness")),
  } as unknown as ProviderTurnLivenessRepositoryShape;
  const record = (
    acknowledge: NonNullable<Parameters<typeof recordAcceptedSendTurn>[0]["acknowledge"]>,
    options: { readonly withoutLiveness?: boolean } = {},
  ) =>
    Effect.runPromise(
      recordAcceptedSendTurn({
        adapter: { provider: "codex", listSessions: () => Effect.succeed([]) },
        directory,
        liveness: options.withoutLiveness ? Option.none() : Option.some(liveness),
        threadId,
        turnId,
        sessionEpoch: 1,
        acknowledge,
      }),
    );
  return { calls, bindings, record };
}

describe("recordAcceptedSendTurn", () => {
  it("writes liveness and the binding inside the acknowledgement", async () => {
    const h = makeHarness();
    await h.record((writes) =>
      writes.pipe(Effect.tap(() => Effect.sync(() => h.calls.push("ack")))),
    );
    expect(h.calls).toEqual(["liveness", "binding", "ack"]);
  });

  it("acknowledges with the binding even without a turn liveness repository", async () => {
    const h = makeHarness();
    await h.record(
      (writes) => writes.pipe(Effect.tap(() => Effect.sync(() => h.calls.push("ack")))),
      { withoutLiveness: true },
    );
    expect(h.calls).toEqual(["binding", "ack"]);
  });

  it("still starts turn liveness before the binding when the acknowledgement fails", async () => {
    const h = makeHarness();
    // The transaction failed and rolled back: none of its writes stand.
    await h.record(() =>
      Effect.fail(new PersistenceSqlError({ operation: "test", detail: "database is locked" })),
    );
    expect(h.calls).toEqual(["liveness", "binding"]);
    expect(h.bindings.at(-1)?.runtimePayload).toMatchObject({ activeTurnId: turnId });
  });
});

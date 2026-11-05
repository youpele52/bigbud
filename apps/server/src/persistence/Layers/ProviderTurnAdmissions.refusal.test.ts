import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import { ProviderTurnAdmissions } from "../Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "./ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { admissionFixture } from "./ProviderTurnAdmissions.test.ts";

const layer = ProviderTurnAdmissionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("proven native refusal settlement", (it) => {
  it.effect("settles only dispatch-intent to terminal/failed under CAS fences", () =>
    Effect.gen(function* () {
      const journal = yield* ProviderTurnAdmissions;
      const reserved = yield* journal.reserve(admissionFixture("refusal-1"));
      // Reserved rows cannot use the refusal path.
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(journal.settleProvenRefusal(reserved, reserved.createdAt)),
        ),
      );
      const intent = yield* journal.transition(reserved, "dispatch-intent", reserved.createdAt);
      const settled = yield* journal.settleProvenRefusal(intent, intent.createdAt);
      assert.strictEqual(settled.state, "terminal");
      assert.strictEqual(settled.terminalOutcome, "failed");
      assert.strictEqual(settled.revision, 2);
      // Terminal rows never reopen or change outcome; stale fences lose.
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(journal.settleProvenRefusal(intent, intent.createdAt))),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(journal.transition(intent, "accepted", intent.createdAt)),
        ),
      );
      // Generic transition still refuses dispatch-intent -> terminal directly.
      const other = yield* journal.reserve(admissionFixture("refusal-2"));
      const otherIntent = yield* journal.transition(other, "dispatch-intent", other.createdAt);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            journal.transition(otherIntent, "terminal", otherIntent.createdAt, undefined, "failed"),
          ),
        ),
      );
      const accepted = yield* journal.transition(otherIntent, "accepted", otherIntent.createdAt);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(journal.settleProvenRefusal(accepted, accepted.createdAt)),
        ),
      );
    }),
  );
});

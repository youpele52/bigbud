import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  makeOrganizationLedgerPruner,
  ORGANIZATION_BRIDGE_TIMING as T,
} from "./organizationBridge.loops.ts";

it.effect("ledger retention runs at most once per interval and a failure never escapes", () =>
  Effect.gen(function* () {
    let clock = 1_000;
    const calls: number[] = [];
    let failing = true;
    const prune = makeOrganizationLedgerPruner({
      now: () => clock,
      prune: (nowMs) =>
        Effect.suspend(() => {
          calls.push(nowMs);
          return failing ? Effect.fail(new Error("disk busy")) : Effect.succeed(3);
        }),
    });
    // A failed pass is logged, not raised: the bridge attempt must survive it.
    yield* prune;
    assert.deepEqual(calls, [1_000]);
    clock += T.ledgerPruneMs - 1;
    yield* prune;
    assert.deepEqual(calls, [1_000]);
    failing = false;
    clock += 1;
    yield* prune;
    yield* prune;
    assert.deepEqual(calls, [1_000, 1_000 + T.ledgerPruneMs]);
  }),
);

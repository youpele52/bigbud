import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Random } from "effect";

import { makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";
import { replayClaudeMessages } from "./Adapter.stream.subagents.test.helpers.ts";

const SESSION = "sdk-session-limits";
const SENTINEL = {
  type: "system",
  subtype: "files_persisted",
  files: [],
  failed: [],
  processed_at: "2026-10-16T00:00:00.000Z",
  uuid: "00000000-0000-4000-8000-0000000000ff",
  session_id: SESSION,
} as unknown as SDKMessage;

// Shape follows @anthropic-ai/claude-agent-sdk 0.3.301 `SDKRateLimitEvent`.
const rateLimit = (status: string, extra: Record<string, unknown> = {}) =>
  ({
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      resetsAt: 1_790_000_000,
      rateLimitType: "five_hour",
      utilization: 0.92,
      overageEnabled: false,
      ...extra,
    },
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: SESSION,
  }) as unknown as SDKMessage;

const run = (message: SDKMessage) => {
  const harness = makeHarness();
  return replayClaudeMessages(
    harness,
    [message, SENTINEL],
    (event) => event.type === "files.persisted",
  ).pipe(
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

type Warning = Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>;
const warnings = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.filter((event): event is Warning => event.type === "runtime.warning");

describe("Claude rate limits", () => {
  it.effect("publishes bounded rate-limit info without a warning while allowed", () =>
    Effect.gen(function* () {
      const events = yield* run(rateLimit("allowed", { secretField: "drop me" }));
      const updated = events.find((event) => event.type === "account.rate-limits.updated");
      assert.deepEqual(updated?.type === "account.rate-limits.updated" && updated.payload, {
        rateLimits: {
          status: "allowed",
          resetsAt: 1_790_000_000,
          rateLimitType: "five_hour",
          utilization: 0.92,
          overageEnabled: false,
        },
      });
      assert.deepEqual(warnings(events), []);
    }),
  );

  it.effect("warns near the limit and reports a rejection as an error-severity warning", () =>
    Effect.gen(function* () {
      const near = warnings(yield* run(rateLimit("allowed_warning")));
      assert.equal(near.length, 1);
      assert.match(near[0]!.payload.message, /close to its limit/);
      assert.equal(near[0]!.payload.severity, undefined);
      const rejected = warnings(yield* run(rateLimit("rejected")));
      assert.equal(rejected.length, 1);
      assert.match(rejected[0]!.payload.message, /limit reached/);
      assert.equal(rejected[0]!.payload.severity, "error");
    }),
  );
});

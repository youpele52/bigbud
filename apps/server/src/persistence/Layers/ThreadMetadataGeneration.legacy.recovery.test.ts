import { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { scanLegacyMetadataSuccessfulModel } from "./ThreadMetadataGeneration.legacy.admission.ts";
import type { LegacyMetadataEvidence } from "./ThreadMetadataGeneration.legacy.ts";
import { at } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";

const threadId = ThreadId.makeUnsafe("legacy-model-proof");
const model: LegacyMetadataEvidence = {
  key: "model",
  commandId: "model",
  witness: "accepted",
  sequence: 10,
  activity: {
    id: EventId.makeUnsafe("model"),
    kind: "text-generation.model-succeeded",
    tone: "info",
    summary: "Historical success",
    turnId: null,
    createdAt: at,
    payload: { provider: "codex", model: "verified" },
  },
};

it.effect("model recovery rejects incomplete, stalled, and regressing history", () =>
  Effect.gen(function* () {
    for (const mode of ["unending", "stalled", "regressing"] as const) {
      let calls = 0;
      const result = yield* scanLegacyMetadataSuccessfulModel(
        () =>
          Effect.sync(() => {
            calls++;
            return {
              evidence: [model],
              nextKey:
                mode === "unending"
                  ? String(calls).padStart(6, "0")
                  : mode === "stalled"
                    ? "same"
                    : calls === 1
                      ? "z"
                      : "a",
            };
          }),
        threadId,
      );
      assert.deepStrictEqual(result, { allowed: false, reason: "scan-limit" });
      assert.strictEqual(calls, mode === "unending" ? 100 : 2);
    }
  }),
);

it.effect("proof scans beyond known paid work and refuses any unknown evidence", () =>
  Effect.gen(function* () {
    let calls = 0;
    const result = yield* scanLegacyMetadataSuccessfulModel(
      () =>
        Effect.sync(() => {
          calls++;
          return calls === 1
            ? {
                evidence: [
                  model,
                  {
                    ...model,
                    key: "paid",
                    activity: {
                      ...model.activity!,
                      kind: "text-generation.request-started",
                      payload: { requestId: "owner" },
                    },
                  },
                ],
                nextKey: "paid",
              }
            : { evidence: [{ ...model, witness: "unknown" as const }], nextKey: null };
        }),
      threadId,
    );
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(result, { allowed: false, reason: "unknown-evidence" });
  }),
);

it.effect("uses maximum canonical sequence across pages, not lexical order or timestamps", () =>
  Effect.gen(function* () {
    let calls = 0;
    const result = yield* scanLegacyMetadataSuccessfulModel(
      () =>
        Effect.sync(() => {
          calls++;
          return calls === 1
            ? { evidence: [model], nextKey: "model" }
            : {
                evidence: [
                  {
                    ...model,
                    key: "z-old",
                    sequence: 1,
                    activity: {
                      ...model.activity!,
                      createdAt: "2026-11-10T00:00:00.000Z",
                      payload: { provider: "codex", model: "old" },
                    },
                  },
                ],
                nextKey: null,
              };
        }),
      threadId,
    );
    assert.deepStrictEqual(result, {
      allowed: true,
      successfulModel: { provider: "codex", model: "verified" },
    });
  }),
);

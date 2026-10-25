import { Effect } from "effect";
import { realpath } from "node:fs/promises";
import { expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { makeIsolatedOpencodeV2Adapter } from "./Adapter.execution.ts";

it("reports failed legacy adoption and material conflicts without native replacement, while a fresh shared binding can start", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, directory, http }) => {
    const options = sharedV2FixtureOptions(fixture, http);
    const canonicalDirectory = await realpath(directory);
    const input = {
      threadId: ThreadId.makeUnsafe("legacy-adoption-diagnostics"),
      cwd: directory,
      runtimeMode: "approval-required" as const,
      modelSelection: {
        provider: "opencodeV2" as const,
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    };
    const creates = () =>
      http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session")
        .length;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { adapter } = yield* makeIsolatedOpencodeV2Adapter(options);
          expect(
            yield* Effect.result(
              adapter.startSession({
                ...input,
                resumeCursor: {
                  provider: "opencodeV2",
                  nativeSessionId: "ses_original_legacy_history",
                  storageIdentity: options.config.sharedService.storageIdentity,
                  connectionMode: "shared",
                  directory: canonicalDirectory,
                },
              }),
            ),
          ).toMatchObject({
            _tag: "Failure",
            failure: {
              issue:
                "V2 bound session unavailable; retained creation/admission intent, no replacement.",
            },
          });
          const original = yield* options.sharedBindings!.find(input.threadId);
          expect(original).toMatchObject({
            state: "reserved",
            revision: 0,
            identityKind: "adopted-legacy-v1",
          });
          expect(
            yield* Effect.result(
              adapter.startSession({
                ...input,
                modelSelection: { ...input.modelSelection, model: "second-model" },
              }),
            ),
          ).toMatchObject({
            _tag: "Failure",
            failure: {
              issue:
                "V2 Shared binding reservation differs from retained material; history retained, no replay.",
            },
          });
          expect(yield* options.sharedBindings!.find(input.threadId)).toEqual(original);
          expect(yield* options.journal.latestBound(input.threadId)).toBeUndefined();
          expect(creates()).toBe(0);
          expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
          const fresh = yield* adapter.startSession({
            ...input,
            threadId: ThreadId.makeUnsafe("genuinely-new-binding"),
          });
          expect(fresh.status).toBe("ready");
          expect(creates()).toBe(1);
          expect(yield* options.sharedBindings!.find(input.threadId)).toEqual(original);
        }),
      ),
    );
  });
});

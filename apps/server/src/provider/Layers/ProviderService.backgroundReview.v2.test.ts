import { expect, it } from "vitest";
import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts";
import { ProviderAdapterValidationError, ProviderValidationError } from "../Errors.ts";
import { makeBackgroundReviews } from "./ProviderService.backgroundReview.ts";
import { makeDormantOpencodeV2Adapter } from "./OpencodeV2/Adapter.ts";
import { getProviderCapabilities } from "../providerCapabilities.ts";

it("V2 durable review preserves the cleanup operation across service wrapping so learning retains its lease", async () => {
  const adapter = {
    ...makeDormantOpencodeV2Adapter(),
    runBackgroundReview: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: "opencodeV2",
          operation: "ProviderService.runBackgroundReview.cleanup",
          issue: "synthetic unconfirmed cleanup",
        }),
      ),
  };
  const reviews = makeBackgroundReviews({
    registry: {
      getByProvider: () => Effect.succeed(adapter),
      listProviders: () => Effect.succeed(["opencodeV2"]),
    },
    serverSettings: {
      getSettings: Effect.succeed({ providers: { opencodeV2: { enabled: true } } }),
    },
    getProviderCapabilities,
    isProviderComposed: () => true,
  });
  const error = await Effect.runPromise(
    reviews
      .run({
        ownerThreadId: ThreadId.makeUnsafe("v2-cleanup-owner"),
        jobId: "v2-cleanup-job",
        cwd: "/synthetic",
        input: "synthetic",
        modelSelection: { provider: "opencodeV2", subProviderID: "synthetic", model: "synthetic" },
      })
      .pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(ProviderValidationError);
  expect(error).toMatchObject({ operation: "ProviderService.runBackgroundReview.cleanup" });
  expect(error.message).toContain("retain owner lease");
});

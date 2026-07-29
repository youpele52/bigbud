import { assert } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { Effect, Option } from "effect";

import { ProviderValidationError } from "../Errors.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { asThreadId, makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";

const safety = makeProviderServiceLayer();

safety.layer("ProviderServiceLive start-session safety", (it) => {
  it.effect("rejects contradictory providers before adapter or persistence side effects", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-provider-mismatch");
      const priorCodexStarts = safety.codex.startSession.mock.calls.length;
      const priorCliProxyStarts = safety.cliProxy.startSession.mock.calls.length;

      const result = yield* provider
        .startSession(threadId, {
          provider: "codex",
          threadId,
          modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.startSession",
          issue: "Provider 'codex' does not match modelSelection provider 'cliProxy'.",
        }),
      );
      assert.equal(safety.codex.startSession.mock.calls.length, priorCodexStarts);
      assert.equal(safety.cliProxy.startSession.mock.calls.length, priorCliProxyStarts);
      assert.equal(Option.isNone(yield* directory.getBinding(threadId)), true);
    }),
  );
});

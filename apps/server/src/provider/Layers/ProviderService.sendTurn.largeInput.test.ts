import { expect } from "vitest";
import { Effect } from "effect";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { asThreadId, makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";

const harness = makeProviderServiceLayer();
harness.layer("ProviderService large input validation boundary", (it) => {
  for (const length of [120_001, 240_000]) {
    it.effect(`passes ${length} characters unchanged to the adapter once`, () =>
      Effect.gen(function* () {
        const service = yield* ProviderService;
        const threadId = asThreadId(`large-${length}`);
        yield* service.startSession(threadId, {
          threadId,
          provider: "codex",
          runtimeMode: "full-access",
        });
        harness.codex.sendTurn.mockClear();
        const input = `START${"x".repeat(length - 8)}END`;
        yield* service.sendTurn({ threadId, input: `  ${input}\n` });
        expect(harness.codex.sendTurn).toHaveBeenCalledOnce();
        expect(harness.codex.sendTurn.mock.calls[0]?.[0].input).toBe(input);
      }),
    );
  }

  it.effect("retains attachment-only sends, empty rejection and adapter errors", () =>
    Effect.gen(function* () {
      const service = yield* ProviderService;
      const threadId = asThreadId("other-validation");
      yield* service.startSession(threadId, {
        threadId,
        provider: "codex",
        runtimeMode: "full-access",
      });
      harness.codex.sendTurn.mockClear();
      const empty = yield* service.sendTurn({ threadId }).pipe(Effect.flip);
      expect(empty._tag).toBe("ProviderValidationError");
      expect(harness.codex.sendTurn).not.toHaveBeenCalled();
      const attachments = [
        {
          type: "image" as const,
          id: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      ];
      yield* service.sendTurn({ threadId, attachments });
      expect(harness.codex.sendTurn.mock.calls[0]?.[0].attachments).toEqual(attachments);
      const failure = new ProviderAdapterRequestError({
        provider: "codex",
        method: "turn/start",
        detail: "native provider failure",
      });
      harness.codex.sendTurn.mockImplementationOnce(() => Effect.fail(failure));
      expect(yield* service.sendTurn({ threadId, input: "valid" }).pipe(Effect.flip)).toBe(failure);
      expect(harness.codex.sendTurn).toHaveBeenCalledTimes(2);
    }),
  );
});

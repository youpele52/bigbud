import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
import { probeClaudeCapabilities } from "./Provider.capabilities";

function hangingRuntime() {
  const close = vi.fn();
  let controller: AbortController | undefined;
  sdk.query.mockImplementation(({ options }) => {
    controller = options.abortController;
    return { initializationResult: () => new Promise(() => {}), close };
  });
  return { close, aborted: () => controller?.signal.aborted };
}

afterEach(() => vi.clearAllMocks());
describe("Claude discovery runtime cleanup", () => {
  it.effect("aborts and closes a hung initialization when the probe times out", () =>
    Effect.gen(function* () {
      const runtime = hangingRuntime();
      const fiber = yield* probeClaudeCapabilities("claude").pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust(8_000);
      yield* Fiber.join(fiber);
      assert.strictEqual(runtime.aborted(), true);
      assert.strictEqual(runtime.close.mock.calls.length, 1);
    }),
  );

  it.effect("aborts and closes a hung initialization before manual cancellation completes", () =>
    Effect.gen(function* () {
      const runtime = hangingRuntime();
      const fiber = yield* probeClaudeCapabilities("claude").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(runtime.aborted(), false);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(runtime.aborted(), true);
      assert.strictEqual(runtime.close.mock.calls.length, 1);
    }),
  );
});

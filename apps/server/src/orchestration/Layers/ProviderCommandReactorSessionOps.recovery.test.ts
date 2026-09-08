import { type ProviderSession, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  isProviderContextLimitError,
  rolloverProviderSessionAtHighWater,
  shouldManagedCapabilityContextRollover,
} from "./ProviderCommandReactorSessionOps.recovery.ts";

describe("ProviderCommandReactorSessionOps recovery", () => {
  it("classifies nested provider context-limit details", () => {
    expect(
      isProviderContextLimitError({
        cause: { detail: "maximum context length exceeded for this model" },
      }),
    ).toBe(true);
    expect(isProviderContextLimitError({ detail: "provider process exited" })).toBe(false);
  });

  it("uses provider-specific high-water marks only for current-context usage", () => {
    const activities = [
      {
        kind: "context-window.updated",
        payload: { usedTokens: 92_000, maxTokens: 100_000 },
      },
    ];
    expect(
      shouldManagedCapabilityContextRollover({
        provider: "codex",
        tokenUsageSemantics: "current-context",
        activities,
      }),
    ).toBe(true);
    expect(
      shouldManagedCapabilityContextRollover({
        provider: "codex",
        tokenUsageSemantics: "cumulative-only",
        activities,
      }),
    ).toBe(false);
  });

  it("keeps an active CLIProxy session without resolving core capabilities", async () => {
    const activeSession = {
      provider: "cliProxy",
      status: "ready",
      runtimeMode: "full-access",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    } satisfies ProviderSession;

    await expect(
      Effect.runPromise(
        rolloverProviderSessionAtHighWater({
          providerService: {} as never,
          states: new Map(),
          threadId: activeSession.threadId,
          sessionEpoch: 0,
          activeSession,
          activities: [],
        }),
      ),
    ).resolves.toBe(activeSession);
  });
});

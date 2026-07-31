import { describe, expect, it } from "vitest";

import {
  isProviderContextLimitError,
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
});

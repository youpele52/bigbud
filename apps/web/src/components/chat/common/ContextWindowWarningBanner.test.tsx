import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => ({ contextWindowWarningThresholdTokens: 120_000 }));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => mockSettings,
}));

import { ContextWindowWarningBanner } from "./ContextWindowWarningBanner";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";

const BASE_USAGE = {
  usedTokens: 100_000,
  maxTokens: 200_000,
  usedPercentage: 50,
  remainingTokens: 100_000,
  remainingPercentage: 50,
  totalProcessedTokens: null,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: false,
  updatedAt: "2024-01-01T00:00:00Z",
} satisfies ContextWindowSnapshot;

describe("ContextWindowWarningBanner", () => {
  afterEach(() => {
    mockSettings.contextWindowWarningThresholdTokens = 120_000;
  });

  it("renders warning when usedTokens exceeds threshold", () => {
    mockSettings.contextWindowWarningThresholdTokens = 100_000;

    const markup = renderToStaticMarkup(
      <ContextWindowWarningBanner
        usage={{ ...BASE_USAGE, usedTokens: 120_000, usedPercentage: 60 }}
      />,
    );

    expect(markup).toContain("Context window warning");
    expect(markup).toContain("Consider using a handoff skill or /compact");
  });

  it("renders nothing when usedTokens is below threshold", () => {
    mockSettings.contextWindowWarningThresholdTokens = 200_000;

    const markup = renderToStaticMarkup(<ContextWindowWarningBanner usage={BASE_USAGE} />);

    expect(markup).toBe("");
  });

  it("renders nothing when usage is null", () => {
    const markup = renderToStaticMarkup(<ContextWindowWarningBanner usage={null} />);

    expect(markup).toBe("");
  });

  it("displays the threshold value in the warning text", () => {
    mockSettings.contextWindowWarningThresholdTokens = 150_000;

    const markup = renderToStaticMarkup(
      <ContextWindowWarningBanner
        usage={{ ...BASE_USAGE, usedTokens: 160_000, usedPercentage: 80 }}
      />,
    );

    expect(markup).toContain("150k");
  });
});

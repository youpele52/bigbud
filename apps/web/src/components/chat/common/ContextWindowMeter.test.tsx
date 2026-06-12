import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => ({ contextWindowWarningThresholdTokens: 120_000 }));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => mockSettings,
}));

import { ContextWindowMeter } from "./ContextWindowMeter";
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

describe("ContextWindowMeter", () => {
  afterEach(() => {
    mockSettings.contextWindowWarningThresholdTokens = 120_000;
  });

  it("shows warning styling when usedTokens exceeds threshold", () => {
    mockSettings.contextWindowWarningThresholdTokens = 100_000;

    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={{ ...BASE_USAGE, usedTokens: 120_000, usedPercentage: 60 }} />,
    );

    expect(markup).toContain("text-warning");
    expect(markup).toContain("color-warning");
  });

  it("hides warning styling when usedTokens is below threshold", () => {
    mockSettings.contextWindowWarningThresholdTokens = 200_000;

    const markup = renderToStaticMarkup(<ContextWindowMeter usage={BASE_USAGE} />);

    expect(markup).not.toContain("text-warning");
    expect(markup).toContain("text-muted-foreground");
  });
});

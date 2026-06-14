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

function makeProps(
  overrides: Partial<React.ComponentProps<typeof ContextWindowWarningBanner>> = {},
) {
  return {
    usage: BASE_USAGE,
    handoffAvailable: true,
    compactAvailable: true,
    onUseHandoff: vi.fn(),
    onCompact: vi.fn(),
    ...overrides,
  };
}

describe("ContextWindowWarningBanner", () => {
  afterEach(() => {
    mockSettings.contextWindowWarningThresholdTokens = 120_000;
  });

  it("renders warning when usedTokens exceeds threshold", () => {
    mockSettings.contextWindowWarningThresholdTokens = 100_000;

    const markup = renderToStaticMarkup(
      <ContextWindowWarningBanner
        {...makeProps({ usage: { ...BASE_USAGE, usedTokens: 120_000, usedPercentage: 60 } })}
      />,
    );

    expect(markup).toContain("Context window warning");
    expect(markup).toContain("Consider using a handoff skill or /compact");
  });

  it("renders nothing when usedTokens is below threshold", () => {
    mockSettings.contextWindowWarningThresholdTokens = 200_000;

    const markup = renderToStaticMarkup(<ContextWindowWarningBanner {...makeProps()} />);

    expect(markup).toBe("");
  });

  it("renders nothing when usage is null", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowWarningBanner {...makeProps({ usage: null })} />,
    );

    expect(markup).toBe("");
  });

  it("displays the threshold value in the warning text", () => {
    mockSettings.contextWindowWarningThresholdTokens = 150_000;

    const markup = renderToStaticMarkup(
      <ContextWindowWarningBanner
        {...makeProps({ usage: { ...BASE_USAGE, usedTokens: 160_000, usedPercentage: 80 } })}
      />,
    );

    expect(markup).toContain("150k");
  });

  it("shows handoff and compact buttons when available", () => {
    mockSettings.contextWindowWarningThresholdTokens = 100_000;

    const markup = renderToStaticMarkup(
      <ContextWindowWarningBanner
        {...makeProps({ usage: { ...BASE_USAGE, usedTokens: 120_000, usedPercentage: 60 } })}
      />,
    );

    expect(markup).toContain("Use handoff");
    expect(markup).toContain("Compact");
  });

  it("hides handoff button when handoff is unavailable", () => {
    mockSettings.contextWindowWarningThresholdTokens = 100_000;

    const markup = renderToStaticMarkup(
      <ContextWindowWarningBanner
        {...makeProps({
          usage: { ...BASE_USAGE, usedTokens: 120_000, usedPercentage: 60 },
          handoffAvailable: false,
        })}
      />,
    );

    expect(markup).not.toContain("Use handoff");
    expect(markup).toContain("Compact");
  });

  it("hides compact button when compact is unavailable", () => {
    mockSettings.contextWindowWarningThresholdTokens = 100_000;

    const markup = renderToStaticMarkup(
      <ContextWindowWarningBanner
        {...makeProps({
          usage: { ...BASE_USAGE, usedTokens: 120_000, usedPercentage: 60 },
          compactAvailable: false,
        })}
      />,
    );

    expect(markup).toContain("Use handoff");
    expect(markup).not.toContain("Compact");
  });
});

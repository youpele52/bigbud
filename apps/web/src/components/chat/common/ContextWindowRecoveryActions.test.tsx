import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ContextWindowRecoveryActions } from "./ContextWindowRecoveryActions";

function makeProps(
  overrides: Partial<React.ComponentProps<typeof ContextWindowRecoveryActions>> = {},
) {
  return {
    handoffAvailable: true,
    compactAvailable: true,
    onUseHandoff: vi.fn(),
    onCompact: vi.fn(),
    ...overrides,
  };
}

describe("ContextWindowRecoveryActions", () => {
  it("renders both buttons when available", () => {
    const markup = renderToStaticMarkup(<ContextWindowRecoveryActions {...makeProps()} />);

    expect(markup).toContain("Use handoff");
    expect(markup).toContain("Compact");
  });

  it("hides handoff button when handoff is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowRecoveryActions {...makeProps({ handoffAvailable: false })} />,
    );

    expect(markup).not.toContain("Use handoff");
    expect(markup).toContain("Compact");
  });

  it("hides compact button when compact is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowRecoveryActions {...makeProps({ compactAvailable: false })} />,
    );

    expect(markup).toContain("Use handoff");
    expect(markup).not.toContain("Compact");
  });

  it("hides both buttons when neither is available", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowRecoveryActions
        {...makeProps({ handoffAvailable: false, compactAvailable: false })}
      />,
    );

    expect(markup).not.toContain("Use handoff");
    expect(markup).not.toContain("Compact");
  });
});

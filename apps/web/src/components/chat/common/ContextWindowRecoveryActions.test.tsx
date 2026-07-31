import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ContextWindowRecoveryActions } from "./ContextWindowRecoveryActions";

function makeProps(
  overrides: Partial<React.ComponentProps<typeof ContextWindowRecoveryActions>> = {},
) {
  return {
    handoffAvailable: true,
    onUseHandoff: vi.fn(),
    ...overrides,
  };
}

describe("ContextWindowRecoveryActions", () => {
  it("renders the handoff button when available", () => {
    const markup = renderToStaticMarkup(<ContextWindowRecoveryActions {...makeProps()} />);

    expect(markup).toContain("Use handoff");
  });

  it("hides handoff button when handoff is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowRecoveryActions {...makeProps({ handoffAvailable: false })} />,
    );

    expect(markup).not.toContain("Use handoff");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProviderSwitchBranchModal } from "./ProviderSwitchBranchModal";

function makeProps(
  overrides: Partial<React.ComponentProps<typeof ProviderSwitchBranchModal>> = {},
) {
  return {
    targetLabel: "OpenCode",
    selectedMode: "handoff" as const,
    onSelectMode: vi.fn(),
    isGeneratingHandoff: false,
    handoffError: null,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe("ProviderSwitchBranchModal", () => {
  it("renders the modal with both branch mode options", () => {
    const markup = renderToStaticMarkup(<ProviderSwitchBranchModal {...makeProps()} />);

    expect(markup).toContain("Start a new OpenCode branch?");
    expect(markup).toContain("Start with handoff summary");
    expect(markup).toContain("Continue with conversation context");
    expect(markup).toContain("Create branch");
    expect(markup).toContain("Cancel");
  });

  it("shows the generating state when handoff is in progress", () => {
    const markup = renderToStaticMarkup(
      <ProviderSwitchBranchModal {...makeProps({ isGeneratingHandoff: true })} />,
    );

    expect(markup).toContain("Generating handoff");
  });

  it("shows an error message when handoff generation fails", () => {
    const markup = renderToStaticMarkup(
      <ProviderSwitchBranchModal {...makeProps({ handoffError: "Handoff failed." })} />,
    );

    expect(markup).toContain("Handoff failed.");
  });
});

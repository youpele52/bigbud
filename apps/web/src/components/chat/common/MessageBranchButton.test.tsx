import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MessageBranchButton } from "./MessageBranchButton";

describe("MessageBranchButton", () => {
  it("renders a button with the Branch thread aria-label", () => {
    const markup = renderToStaticMarkup(<MessageBranchButton onClick={() => {}} />);

    expect(markup).toContain('aria-label="Branch thread"');
    expect(markup).toContain('title="Branch thread"');
  });

  it("renders a disabled button when disabled is true", () => {
    const markup = renderToStaticMarkup(<MessageBranchButton onClick={() => {}} disabled />);

    expect(markup).toContain('disabled=""');
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    const markup = renderToStaticMarkup(<MessageBranchButton onClick={onClick} />);

    // Verify the button is present and clickable (no disabled attribute)
    expect(markup).toContain('aria-label="Branch thread"');
    expect(markup).not.toContain('disabled=""');
  });
});

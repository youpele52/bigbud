import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarThreadProviderIcon } from "./SidebarThreadProviderIcon";

describe("SidebarThreadProviderIcon", () => {
  it("keeps the provider svg nested beneath the semantic state color", () => {
    const markup = renderToStaticMarkup(
      <SidebarThreadProviderIcon
        icon={(props) => <svg {...props} data-testid="provider-icon" />}
        colorClass="text-warning"
        animationClass="animate-breathe"
      />,
    );

    expect(markup).toContain('data-slot="thread-provider-icon"');
    expect(markup).toContain("text-warning");
    expect(markup).toMatch(/<span[^>]*><svg/);
    expect(markup).not.toMatch(/<svg[^>]*text-warning/);
  });
});

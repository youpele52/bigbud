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

  it("applies violet and the established breathing class together for child activity", () => {
    const markup = renderToStaticMarkup(
      <SidebarThreadProviderIcon
        icon={(props) => <svg {...props} />}
        colorClass="text-violet-500"
        animationClass="animate-breathe motion-reduce:animate-none"
      />,
    );
    expect(markup).toContain("text-violet-500");
    expect(markup).toContain("animate-breathe");
    expect(markup).toContain("motion-reduce:animate-none");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MuseIcon } from "./MuseIcon";
import { getProviderDescriptor } from "./providerDescriptors";

describe("MuseIcon", () => {
  it("renders the Meta infinity-loop mark in monochrome currentColor", () => {
    const markup = renderToStaticMarkup(<MuseIcon className="size-4" />);
    expect(markup).toContain('class="size-4"');
    expect(markup).toContain('viewBox="1.8916 6.0313 30 19.9369"');
    expect(markup.match(/fill="currentColor"/g)).toHaveLength(15);
    expect(markup).not.toMatch(/#0082FB|#0064E0|url\(#paint|linearGradient/i);
  });

  it("is the single icon used by the Muse provider descriptor", () => {
    expect(getProviderDescriptor("muse").icon).toBe(MuseIcon);
  });
});

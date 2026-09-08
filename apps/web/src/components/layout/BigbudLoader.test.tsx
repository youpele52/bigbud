import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BigbudLoader } from "./BigbudLoader";

describe("BigbudLoader", () => {
  it("fills and centers its parent with the launch breathing logo", () => {
    const markup = renderToStaticMarkup(<BigbudLoader label="Loading git state..." />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("h-full");
    expect(markup).toContain("w-full");
    expect(markup).toContain("items-center");
    expect(markup).toContain("justify-center");
    expect(markup).toContain("animate-pulse-slow");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("bigbud-logo-title");
    expect(markup).toContain("Loading git state...");
  });
});

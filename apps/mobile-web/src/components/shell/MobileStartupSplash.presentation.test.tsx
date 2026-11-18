import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BigbudLoader } from "~/components/layout/BigbudLoader";
import { MobileStartupSplash } from "./MobileStartupSplash";
import { BigbudLogo } from "./BigbudLogo";

// Render the current desktop reference itself, using no app/store/backend instance.
const surfaces = [
  ["desktop", () => <BigbudLoader />],
  ["mobile", () => <MobileStartupSplash />],
] as const;

describe("current desktop/mobile loading presentation", () => {
  it.each(surfaces)("%s announces one polite loading status", (_name, render) => {
    const markup = renderToStaticMarkup(render());
    const root = markup.match(/^<div\b[^>]*>/)?.[0] ?? "";
    expect({
      status: root.includes('role="status"'),
      polite: root.includes('aria-live="polite"'),
      loadingLabel: markup.includes("Loading application"),
    }).toEqual({ status: true, polite: true, loadingLabel: true });
  });

  it.each(surfaces)(
    "%s treats the animated logo as decorative and supports reduced motion",
    (_name, render) => {
      const markup = renderToStaticMarkup(render());
      const logo = markup.match(/<svg\b[^>]*>/)?.[0];
      expect({
        decorative: logo?.includes('aria-hidden="true"'),
        labelledImage: logo?.includes('role="img"'),
        reducedMotionGuard: logo?.includes("motion-reduce:animate-none"),
      }).toEqual({ decorative: true, labelledImage: false, reducedMotionGuard: true });
    },
  );

  it("preserves mobile connection detail content", () => {
    const markup = renderToStaticMarkup(
      <MobileStartupSplash>
        <p>Still connecting to the selected host</p>
      </MobileStartupSplash>,
    );
    expect(markup).toContain("Still connecting to the selected host");
  });

  it("keeps nondecorative header/empty-state logos individually labelled", () => {
    const markup = renderToStaticMarkup(
      <>
        <BigbudLogo />
        <BigbudLogo />
      </>,
    );
    const titles = Array.from(
      markup.matchAll(/<title id="([^"]+)">bigbud<\/title>/g),
      (match) => match[1],
    );
    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(2);
    expect(markup.match(/role="img"/g)).toHaveLength(2);
    for (const title of titles) expect(markup).toContain(`aria-labelledby="${title}"`);
  });
});

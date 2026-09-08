import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button } from "./button";

describe("Button text variant", () => {
  it("keeps its border quiet until interaction", () => {
    const markup = renderToStaticMarkup(
      <Button size="xs" variant="text">
        Show more
      </Button>,
    );

    expect(markup).toContain("border-transparent");
    expect(markup).toContain("font-normal");
    expect(markup).toContain("text-[9px]");
    expect(markup).toContain("sm:text-[9px]");
    expect(markup).toContain("uppercase");
    expect(markup).toContain("tracking-[0.16em]");
    expect(markup).toContain("hover:border-border/70");
    expect(markup).toContain("active:border-border/80");
    expect(markup).toContain("Show more");
  });
});

describe("Button outline variants", () => {
  it("uses muted secondary styling while preserving the requested size", () => {
    const markup = renderToStaticMarkup(
      <Button size="lg" variant="outline">
        Continue
      </Button>,
    );

    expect(markup).toContain("text-muted-foreground");
    expect(markup).toContain("transition-[color,background-color,box-shadow]");
    expect(markup).toContain("[:hover,:active,[data-pressed]]:text-foreground");
    expect(markup).toContain("[:hover,:active,[data-pressed]]:bg-accent/50");
    expect(markup).toContain("h-10");
    expect(markup).toContain("sm:h-9");
    expect(markup).not.toContain("h-8");
    expect(markup).not.toContain("sm:h-7");
  });

  it("uses compact secondary dimensions by default", () => {
    const markup = renderToStaticMarkup(<Button variant="outline">Restore defaults</Button>);

    expect(markup).toContain("text-muted-foreground");
    expect(markup).toContain("transition-[color,background-color,box-shadow]");
    expect(markup).toContain("[:hover,:active,[data-pressed]]:text-foreground");
    expect(markup).toContain("[:hover,:active,[data-pressed]]:bg-accent/50");
    expect(markup).toContain("h-8");
    expect(markup).toContain("sm:h-7");
  });
});

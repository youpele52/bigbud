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

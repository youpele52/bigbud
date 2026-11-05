import { Comment03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadOriginLink } from "./ThreadOriginLink";

describe("ThreadOriginLink", () => {
  it("renders unavailable threads as non-link fallback text", () => {
    const markup = renderToStaticMarkup(
      <ThreadOriginLink
        threadId={"deleted" as never}
        title="Unavailable thread"
        available={false}
      />,
    );
    expect(markup).toContain("Unavailable thread");
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("href=");
  });

  it("uses the Recents icon for source-thread references", () => {
    const markup = renderToStaticMarkup(
      <ThreadOriginLink
        threadId={"source" as never}
        title="Source thread"
        prefix="Agent from"
        available={false}
      />,
    );
    const icon = renderToStaticMarkup(
      <HugeiconsIcon
        aria-hidden="true"
        className="size-3 shrink-0"
        icon={Comment03Icon}
        size={12}
        strokeWidth={1.5}
      />,
    );

    expect(markup).toContain(icon);
    expect(markup).toContain("Agent from");
    expect(markup).toContain("Source thread");
  });
});

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
});

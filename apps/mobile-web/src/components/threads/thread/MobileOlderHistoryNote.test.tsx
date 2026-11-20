import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MobileOlderHistoryNote } from "./MobileOlderHistoryNote";

describe("MobileOlderHistoryNote", () => {
  it("renders one small muted line when older history stayed on the desktop", () => {
    const markup = renderToStaticMarkup(<MobileOlderHistoryNote visible />);
    expect(markup).toContain("Earlier messages are on the desktop.");
    expect(markup).toContain("text-xs");
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain("<button");
  });

  it("renders nothing when the transcript is complete", () => {
    expect(renderToStaticMarkup(<MobileOlderHistoryNote visible={false} />)).toBe("");
  });
});

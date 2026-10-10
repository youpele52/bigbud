import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  isLegacyOpencodeThread,
  LEGACY_OPENCODE_READ_ONLY_MESSAGE,
} from "@bigbud/shared/providerLifecycle";
import { LegacyOpencodeNotice } from "./LegacyOpencodeNotice";

describe("legacy OpenCode history presentation", () => {
  it("shows actionable read-only guidance, not runtime controls", () => {
    const markup = renderToStaticMarkup(<LegacyOpencodeNotice />);
    expect(markup).toContain(LEGACY_OPENCODE_READ_ONLY_MESSAGE);
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<button");
  });
  it("recognizes web and orchestration session IDs without conflating V2", () => {
    expect(isLegacyOpencodeThread({ session: { provider: "opencode" } })).toBe(true);
    expect(isLegacyOpencodeThread({ session: { providerName: "opencode" } })).toBe(true);
    expect(isLegacyOpencodeThread({ modelSelection: { provider: "opencodeV2" } })).toBe(false);
  });
});

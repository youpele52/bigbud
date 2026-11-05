import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { BROWSER_SEARCH_ENGINES } from "../constants/browser.constant";
import { ClientSettingsSchema } from "./settings";

const decode = Schema.decodeUnknownSync(ClientSettingsSchema);

describe("browser search engine setting", () => {
  it("defaults older saved settings to DuckDuckGo while keeping other preferences", () => {
    expect(decode({ terminalFontSize: 16 })).toMatchObject({
      browserSearchEngine: "duckduckgo",
      terminalFontSize: 16,
    });
  });

  it.each(BROWSER_SEARCH_ENGINES)("preserves a saved %s selection", (browserSearchEngine) => {
    const decoded = decode({ browserSearchEngine });
    expect(decode(JSON.parse(JSON.stringify(decoded))).browserSearchEngine).toBe(
      browserSearchEngine,
    );
  });

  it("rejects unsupported engines", () => {
    expect(() => decode({ browserSearchEngine: "unsupported" })).toThrow();
  });
});

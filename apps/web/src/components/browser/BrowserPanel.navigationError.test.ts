import { describe, expect, it } from "vitest";

import { classifyBrowserNavigationError } from "./BrowserPanel.navigationError";

describe("classifyBrowserNavigationError", () => {
  it.each([
    ["ERR_NAME_NOT_RESOLVED", "This site can't be reached"],
    ["ERR_INTERNET_DISCONNECTED", "You're offline"],
    ["ERR_CONNECTION_REFUSED", "This site can't be reached"],
    ["ERR_CONNECTION_TIMED_OUT", "This site took too long to respond"],
    ["ERR_CERT_AUTHORITY_INVALID", "Your connection isn't private"],
  ])("classifies %s", (errorDescription, title) => {
    expect(
      classifyBrowserNavigationError({
        errorCode: -1,
        errorDescription,
        validatedURL: "https://example.com/path",
      }),
    ).toMatchObject({ title, technicalCode: errorDescription });
  });

  it("uses a safe fallback for unknown and invalid URLs", () => {
    expect(
      classifyBrowserNavigationError({
        errorCode: 99,
        errorDescription: "not useful",
        validatedURL: "not a URL",
      }),
    ).toMatchObject({
      title: "This page couldn't be loaded",
      description: "bigbud couldn't load This site.",
      technicalCode: "UNKNOWN_NAVIGATION_ERROR",
    });
  });

  it("describes date-invalid certificates accurately", () => {
    expect(
      classifyBrowserNavigationError({
        errorCode: -201,
        errorDescription: "ERR_CERT_DATE_INVALID",
        validatedURL: "https://africa.h2atlas.de/africa",
      }),
    ).toMatchObject({
      title: "This site's certificate isn't valid",
      description:
        "africa.h2atlas.de's certificate has expired or is not yet valid. Your computer's date and time can also cause this error.",
      technicalCode: "ERR_CERT_DATE_INVALID",
    });
  });
});

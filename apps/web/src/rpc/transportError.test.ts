import { describe, expect, it } from "vitest";

import { isTransportConnectionErrorMessage, sanitizeThreadErrorMessage } from "./transportError";

describe("isTransportConnectionErrorMessage", () => {
  it.each([
    "SocketCloseError: An error occurred during Close",
    "SocketOpenError: An error occurred during Open",
    "SocketReadError: An error occurred during Read",
    "ping timeout",
  ])("classifies %s as a transport failure", (message) => {
    expect(isTransportConnectionErrorMessage(message)).toBe(true);
    expect(sanitizeThreadErrorMessage(message)).toBeNull();
  });

  it("keeps provider and application errors visible", () => {
    const message = "Provider rejected the request: rate limited";
    expect(isTransportConnectionErrorMessage(message)).toBe(false);
    expect(sanitizeThreadErrorMessage(message)).toBe(message);
  });
});

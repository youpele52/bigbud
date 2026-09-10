import { describe, expect, it } from "vitest";

import { redactMobileText } from "./mobileRedaction";

describe("redactMobileText", () => {
  it("removes tokens from URLs and authorization text", () => {
    expect(redactMobileText("wss://desktop.test/mobile-ws?token=abc123 Bearer secret-token")).toBe(
      "[websocket address redacted] Bearer [redacted]",
    );
  });
});

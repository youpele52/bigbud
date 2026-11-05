import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ProviderControlsInput } from "./providerControls";

describe("epoch-fenced provider controls", () => {
  it.each([undefined, -1, 0.5, "2", null, NaN])("rejects invalid epoch %s", (sessionEpoch) => {
    expect(() =>
      Schema.decodeUnknownSync(ProviderControlsInput)({
        threadId: "chat",
        action: "compact",
        sessionEpoch,
      }),
    ).toThrow();
  });
  it.each(["status", "compact", "refresh-mcp", "reload-mcp"])(
    "accepts %s with an explicit epoch",
    (action) => {
      expect(
        Schema.decodeUnknownSync(ProviderControlsInput)({
          threadId: "chat",
          action,
          sessionEpoch: 2,
        }),
      ).toEqual({ threadId: "chat", action, sessionEpoch: 2 });
    },
  );
  it("rejects invented targeted reconnect actions", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProviderControlsInput)({
        threadId: "chat",
        action: "reconnect",
        sessionEpoch: 2,
      }),
    ).toThrow();
  });
});

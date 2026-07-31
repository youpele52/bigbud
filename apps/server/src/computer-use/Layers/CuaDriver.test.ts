import { describe, expect, it } from "vitest";

import { parseAvailableTools, toCallResult } from "./CuaDriver.ts";

describe("CuaDriver MCP parsing", () => {
  it("reads only valid advertised tool names", () => {
    expect([
      ...parseAvailableTools({ tools: [{ name: "click" }, null, {}, { name: 42 }] }),
    ]).toEqual(["click"]);
  });

  it("fails closed for MCP tool errors", () => {
    expect(() =>
      toCallResult({
        isError: true,
        content: [{ type: "text", text: "Permission denied: blocked" }],
      }),
    ).toThrow("Permission denied: blocked");
  });

  it("preserves text, image, and structured content", () => {
    expect(
      toCallResult({
        content: [
          { type: "text", text: "ok" },
          { type: "image", mimeType: "image/png", data: "AA==" },
        ],
        structuredContent: { verified: true },
      }),
    ).toEqual({
      content: [
        { type: "text", text: "ok" },
        { type: "image", mimeType: "image/png", data: "AA==" },
      ],
      structuredContent: { verified: true },
    });
  });
});

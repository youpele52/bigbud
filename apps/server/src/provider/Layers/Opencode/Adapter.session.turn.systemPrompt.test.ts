import { describe, expect, it } from "vitest";

import { buildOpencodeSystemPrompt } from "./Adapter.session.turn.systemPrompt.ts";

describe("buildOpencodeSystemPrompt", () => {
  it("returns the browser guidance only", () => {
    const prompt = buildOpencodeSystemPrompt();

    expect(prompt).toContain("Chromium browser");
    expect(prompt).not.toContain("workspace root");
  });
});

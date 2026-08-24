import { describe, expect, it } from "vitest";

import { buildOpencodeSystemPrompt } from "./Adapter.session.turn.systemPrompt.ts";

describe("buildOpencodeSystemPrompt", () => {
  it("appends remote workspace authority without removing browser guidance", () => {
    const prompt = buildOpencodeSystemPrompt(
      "The actual workspace root is /home/youpele/DevWorld/bigbud.",
    );

    expect(prompt).toContain("Chromium browser");
    expect(prompt).toContain("actual workspace root is /home/youpele/DevWorld/bigbud");
  });
});

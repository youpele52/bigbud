import { describe, expect, it } from "vitest";

import { buildBootstrapInput } from "./history";

describe("buildBootstrapInput", () => {
  it("includes full transcript when under budget", () => {
    const result = buildBootstrapInput(
      [
        {
          role: "user",
          text: "hello",
        },
        {
          role: "assistant",
          text: "world",
        },
      ],
      "what's next?",
      1_500,
    );

    expect(result.includedCount).toBe(2);
    expect(result.omittedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("USER:\nhello");
    expect(result.text).toContain("ASSISTANT:\nworld");
    expect(result.text).toContain("Latest user request (answer this now):");
    expect(result.text).toContain("what's next?");
  });

  it("truncates older transcript messages when over budget", () => {
    const result = buildBootstrapInput(
      [
        {
          role: "user",
          text: "first question with details",
        },
        {
          role: "assistant",
          text: "first answer with details",
        },
        {
          role: "user",
          text: "second question with details",
        },
      ],
      "final request",
      320,
    );

    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.includedCount).toBeLessThan(3);
    expect(result.text).toContain("omitted to stay within input limits");
    expect(result.text.length).toBeLessThanOrEqual(320);
  });

  it("preserves the latest prompt when prompt-only fallback is required", () => {
    const latestPrompt = "Please keep this exact latest prompt.";
    const result = buildBootstrapInput(
      [
        {
          role: "user",
          text: "old context",
        },
      ],
      latestPrompt,
      latestPrompt.length + 3,
    );

    expect(result.text).toBe(latestPrompt);
    expect(result.includedCount).toBe(0);
    expect(result.omittedCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("captures user image attachment context in transcript blocks", () => {
    const result = buildBootstrapInput(
      [
        {
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "img-1",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 2_048,
            },
          ],
        },
      ],
      "What does this error mean?",
      1_500,
    );

    expect(result.text).toContain("Attached image");
    expect(result.text).toContain("screenshot.png");
  });
});

import { MessageId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { buildBootstrapInput } from "./history";

describe("buildBootstrapInput", () => {
  const hugePrompt = `CURRENT_START${"x".repeat(240_000)}CURRENT_END`;

  it.each([0, 1, -1, NaN, Infinity, -Infinity, 0.9])(
    "preserves the complete request with replay allowance %s",
    (budget) => {
      expect(buildBootstrapInput([], hugePrompt, budget)).toEqual({
        text: hugePrompt,
        includedCount: 0,
        omittedCount: 0,
        truncated: false,
      });
      expect(buildBootstrapInput([{ role: "user", text: "history" }], hugePrompt, budget)).toEqual({
        text: hugePrompt,
        includedCount: 0,
        omittedCount: 1,
        truncated: true,
      });
    },
  );

  it("selects the same newest contiguous history independently of current request size", () => {
    const history = [
      { role: "user" as const, text: "old".repeat(1_000) },
      { role: "assistant" as const, text: "newer answer" },
      { role: "user" as const, text: "recent question" },
    ];
    const short = buildBootstrapInput(history, "short", 350);
    const large = buildBootstrapInput(history, hugePrompt, 350.9);
    expect(large.includedCount).toBe(2);
    expect(large.omittedCount).toBe(1);
    expect(large.truncated).toBe(true);
    expect(large.text.slice(0, -hugePrompt.length)).toBe(short.text.slice(0, -5));
    expect(large.text.length - hugePrompt.length).toBeLessThanOrEqual(350);
    expect(large.text.endsWith(hugePrompt)).toBe(true);
    expect(large.text.indexOf("newer answer")).toBeLessThan(large.text.indexOf("recent question"));
    expect(large.text.length).toBeGreaterThan(240_000);
  });

  it("does not skip a nonfitting recent block to replay an older small block", () => {
    const result = buildBootstrapInput(
      [
        { role: "user", text: "old small" },
        { role: "assistant", text: "large".repeat(1_000) },
      ],
      hugePrompt,
      300,
    );
    expect(result.includedCount).toBe(0);
    expect(result.omittedCount).toBe(2);
    expect(result.text).toContain("2 earlier message(s) omitted");
    expect(result.text).not.toContain("old small");
    expect(result.text.length - hugePrompt.length).toBeLessThanOrEqual(300);
    expect(result.text.endsWith(hugePrompt)).toBe(true);
  });
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
      300,
    );

    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.includedCount).toBeLessThan(3);
    expect(result.text).toContain("omitted to stay within input limits");
    expect(result.text.length - "final request".length).toBeLessThanOrEqual(300);
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

  it("includes reply context as a structured block", () => {
    const result = buildBootstrapInput(
      [
        {
          role: "user",
          text: "follow up",
          replyTo: {
            messageId: MessageId.makeUnsafe("message-1"),
            role: "assistant",
            createdAt: "2026-01-01T00:00:00.000Z",
            excerpt: "Earlier answer",
          },
        },
      ],
      "what next?",
      1_500,
    );

    expect(result.text).toContain("<reply_to_message");
    expect(result.text).toContain('role="assistant"');
    expect(result.text).toContain("Earlier answer");
  });
});

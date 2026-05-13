import { describe, expect, it } from "vitest";

import { appendPiAttachmentInstructions } from "./Adapter.session.helpers.ts";

describe("PiAdapter.session.helpers", () => {
  it("adds attachment handling instructions when file attachments are present", () => {
    const prompt = appendPiAttachmentInstructions({
      prompt: "summarize this",
      hasFileAttachments: true,
    });

    expect(prompt).toContain("summarize this");
    expect(prompt).toContain("Use attached document content only when it appears");
    expect(prompt).toContain("Do not call file-reading tools on attachment paths");
  });

  it("does not change prompts without file attachments", () => {
    expect(
      appendPiAttachmentInstructions({
        prompt: "summarize this image",
        hasFileAttachments: false,
      }),
    ).toBe("summarize this image");
  });
});

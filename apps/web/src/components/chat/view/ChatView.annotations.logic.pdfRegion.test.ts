import { describe, expect, it } from "vitest";
import type { ComposerAnnotationAttachment } from "../../../stores/composer";

import { appendBrowserAnnotationsToPrompt } from "./ChatView.annotations.logic";

describe("appendBrowserAnnotationsToPrompt for PDF regions", () => {
  it("tells the agent to focus on the selected PDF region first", () => {
    const annotation: ComposerAnnotationAttachment = {
      id: "annotation-1",
      imageId: "image-1",
      comment: "What does this section say?",
      intent: "ask",
      page: { title: "Auftrag", url: "https://example.com/form.pdf" },
      element: {
        selector: "",
        tag: "pdf-region",
        role: "region",
        text: "PDF region annotation",
        ariaLabel: null,
        id: null,
        className: "",
        rect: { x: 40, y: 50, width: 140, height: 160 },
      },
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
      createdAt: "2026-06-18T00:00:00.000Z",
    };

    const prompt = appendBrowserAnnotationsToPrompt("", [annotation]);
    expect(prompt).toContain("tightly cropped to the selected PDF region");
    expect(prompt).toContain("Focus your answer on that selected region first");
    expect(prompt).toContain("Only use broader document context");
  });
});

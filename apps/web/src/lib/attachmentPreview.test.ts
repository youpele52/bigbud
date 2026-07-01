import { describe, expect, it } from "vitest";

import { attachmentPreviewRoutePath, toAttachmentPreviewUrl } from "./attachmentPreview";

describe("attachmentPreviewRoutePath", () => {
  it("builds an encoded attachment route", () => {
    expect(attachmentPreviewRoutePath("thread abc/file name.png")).toBe(
      "/attachments/thread%20abc%2Ffile%20name.png",
    );
  });
});

describe("toAttachmentPreviewUrl", () => {
  it("returns relative attachment routes unchanged when no ws origin is available", () => {
    expect(toAttachmentPreviewUrl("/attachments/thread-1")).toBe("/attachments/thread-1");
  });

  it("returns absolute URLs unchanged", () => {
    expect(toAttachmentPreviewUrl("https://cdn.example.com/image.png")).toBe(
      "https://cdn.example.com/image.png",
    );
  });
});

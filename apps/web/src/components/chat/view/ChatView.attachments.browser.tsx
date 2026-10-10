import { expect, it, vi } from "vitest";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../../stores/composer";
import { buildTurnAttachments } from "./ChatView.sendTurn.helpers";

vi.mock("~/config/env/env.config", () => ({ isElectron: true }));

it("desktop prefers genuine image/file paths and retains bytes for pathless clipboard files", async () => {
  const imageFile = new File(["image bytes"], "image.png", { type: "image/png" });
  const file = new File(["document context"], "note.txt", { type: "text/plain" });
  const original = window.desktopBridge;
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { getFilePath: () => "/chosen/image.png" },
  });
  const image: ComposerImageAttachment = {
    type: "image",
    id: "image",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: imageFile.size,
    previewUrl: "",
    file: imageFile,
  };
  const document: ComposerFileAttachment = {
    type: "file",
    id: "document",
    name: "note.txt",
    mimeType: "text/plain",
    sizeBytes: file.size,
    filePath: "",
    file,
  };
  try {
    const local = await buildTurnAttachments(
      [image],
      [{ ...document, filePath: "/chosen/note.txt" }],
    );
    expect(local).toEqual([
      expect.objectContaining({ type: "file", transport: "path", filePath: "/chosen/image.png" }),
      expect.objectContaining({ type: "file", transport: "path", filePath: "/chosen/note.txt" }),
    ]);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { getFilePath: () => "" },
    });
    const fallback = await buildTurnAttachments([image], [document]);
    expect(fallback[0]).toMatchObject({
      type: "image",
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(fallback[1]).toMatchObject({
      type: "file",
      transport: "base64",
      dataUrl: expect.stringContaining(btoa("document context")),
    });
    await expect(buildTurnAttachments([], [{ ...document, file: null }])).rejects.toThrow(
      "Reattach it before sending",
    );
  } finally {
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: original });
  }
});

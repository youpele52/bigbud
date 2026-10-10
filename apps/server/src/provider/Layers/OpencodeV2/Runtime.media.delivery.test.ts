import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import { prepareV2RemoteMedia } from "./Remote.media.ts";
import { prepareV2AttachmentContent } from "./Runtime.media.content.ts";
import type { V2RemoteFiles } from "./Remote.files.ts";
import * as extraction from "../../../attachments/documentText.ts";

it("remote upload fallback never rereads desktop sourcePath and preserves native image plus supplemental context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2-media-delivery-"));
  const bytes = await readFile(
    new URL("../../../../../web/public/favicon-16x16.png", import.meta.url),
  );
  const image = {
    type: "image",
    id: "image",
    name: "pixel.png",
    mimeType: "image/png",
    sizeBytes: bytes.length,
  } as const;
  const file = {
    type: "file",
    id: "file",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 7,
    sourcePath: "/never/reread/desktop",
  } as const;
  const readBytes = vi.fn();
  const remote = {
    root: "/remote/workspace",
    executionTargetId: "ssh:fixture",
    readBytes,
  } as unknown as V2RemoteFiles;
  try {
    await writeFile(resolveAttachmentPath({ attachmentsDir: root, attachment: image })!, bytes);
    await writeFile(resolveAttachmentPath({ attachmentsDir: root, attachment: file })!, "context");
    const result = await prepareV2RemoteMedia(
      { threadId: ThreadId.makeUnsafe("remote"), input: "read", attachments: [file, image] },
      remote,
      root,
      { nativeImages: true, pathReachable: false, tools: true },
    );
    expect(readBytes).not.toHaveBeenCalled();
    expect(result.files).toEqual([
      { uri: expect.stringMatching(/^data:image\/png;base64,/), name: "pixel.png" },
    ]);
    expect(result.text).toContain("context");
    expect(result.text).not.toContain(root);
    expect(result.text).not.toContain(file.sourcePath);
    expect(result.references).toContain("managed-upload");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("broker workspace document references resolve only on their bound target and propagate denied reads without fallback", async () => {
  const readBytes = vi.fn().mockResolvedValue(Buffer.from("remote context"));
  const remote = {
    root: "/remote/workspace",
    executionTargetId: "ssh:fixture",
    readBytes,
  } as unknown as V2RemoteFiles;
  const input = {
    threadId: ThreadId.makeUnsafe("remote"),
    input: "read",
    attachments: [
      {
        type: "path",
        id: "reference",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 0,
        entryKind: "file",
        path: "/remote/workspace/notes.txt",
      },
    ],
  } as const;
  const result = await prepareV2RemoteMedia(input, remote, undefined, { tools: true });
  expect(readBytes).toHaveBeenCalledWith("notes.txt", expect.any(Number));
  expect(result.text).toContain("remote context");
  expect(result.references).toContain("ssh:fixture");
  readBytes.mockRejectedValue(new Error("denied"));
  await expect(prepareV2RemoteMedia(input, remote)).rejects.toThrow("denied");
  expect(readBytes).toHaveBeenCalledTimes(2);
});

it("known visionless image input without OCR fails before opaque binary delivery even with local tools", async () => {
  const extract = vi.spyOn(extraction, "extractPromptTextFromBuffer").mockResolvedValue(null);
  try {
    await expect(
      prepareV2AttachmentContent(
        "read",
        [
          {
            attachment: {
              type: "image",
              id: "image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
            bytes: Buffer.from("x"),
            path: "/verified/snapshot.png",
          },
        ],
        [],
        { nativeImages: false, tools: true },
      ),
    ).rejects.toThrow("Text extraction or OCR is unavailable");
  } finally {
    extract.mockRestore();
  }
});

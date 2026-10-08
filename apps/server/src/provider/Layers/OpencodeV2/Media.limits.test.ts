import { writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { prepareV2Media } from "./Runtime.media.ts";
import { prepareV2RemoteMedia } from "./Remote.media.ts";
import type { V2RemoteFiles } from "./Remote.files.ts";
import { V2_MEDIA_FILE_BYTES, V2_MEDIA_TOTAL_BYTES } from "./Media.limits.ts";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import { assertV2MediaFormat } from "./Media.formats.ts";

it("local and remote inline staging share actual per-file/aggregate budgets, not an arbitrary 1MiB remote cap", async () => {
  await withV2RuntimeFixture(async ({ directory }) => {
    const root = await realpath(directory),
      filename = path.join(root, "large.txt"),
      data = Buffer.alloc(2 * 1024 * 1024, 65);
    await writeFile(filename, data);
    const attachment = {
      type: "path" as const,
      id: "media",
      path: filename,
      mimeType: "text/plain",
      name: "large.txt",
      sizeBytes: 0 as const,
      entryKind: "file" as const,
    };
    const input = {
      threadId: "fixture",
      input: "media",
      attachments: [attachment],
    } as unknown as Parameters<typeof prepareV2Media>[0];
    expect(V2_MEDIA_FILE_BYTES).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    const local = await prepareV2Media(input, root);
    const readBytes = vi.fn(async () => data);
    const remote = await prepareV2RemoteMedia(input, {
      root,
      executionTargetId: "remote",
      readBytes,
    } as unknown as V2RemoteFiles);
    expect(remote.files).toEqual(local.files);
    expect(readBytes).toHaveBeenCalledWith("large.txt", V2_MEDIA_FILE_BYTES);
    await writeFile(filename, Buffer.alloc(V2_MEDIA_FILE_BYTES + 1));
    await expect(prepareV2Media(input, root)).rejects.toThrow("byte bound");
    readBytes.mockResolvedValue(Buffer.alloc(V2_MEDIA_FILE_BYTES, 65));
    await expect(
      prepareV2RemoteMedia(
        { ...input, attachments: [attachment, { ...attachment, id: "second" }] },
        { root, executionTargetId: "remote", readBytes } as unknown as V2RemoteFiles,
      ),
    ).rejects.toThrow("total byte bound");
    expect(V2_MEDIA_TOTAL_BYTES).toBeLessThan(2 * V2_MEDIA_FILE_BYTES);
  });
});

it("rejects unsupported native binary formats before admission, even a PDF mislabeled text, without reducing supported text/images to an arbitrary count", () => {
  for (const [data, mime] of [
    [Buffer.from("%PDF-1.7 fake document"), "text/plain"],
    [Buffer.from([0xff, 0x80]), "application/octet-stream"],
    [Buffer.from("audio data"), "audio/mpeg"],
  ] as const)
    expect(() => assertV2MediaFormat(data, mime)).toThrow("unsupported attachment format");
  expect(() => assertV2MediaFormat(Buffer.from("<svg>text</svg>"), "image/svg+xml")).not.toThrow();
  expect(() =>
    assertV2MediaFormat(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"),
  ).not.toThrow();
});

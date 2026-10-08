import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ProviderSendTurnInput } from "@bigbud/contracts";
import type { SessionPromptInput } from "@opencode/client";
import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import { captureV2MediaIdentity } from "./Runtime.media.identity.ts";
import { V2_MEDIA_FILE_BYTES, V2_MEDIA_TOTAL_BYTES } from "./Media.limits.ts";
import { assertV2MediaFormat } from "./Media.formats.ts";

/** Convert bounded isolated media to inline URIs; never let the native server fetch arbitrary URLs. */
export async function prepareV2Media(
  input: ProviderSendTurnInput,
  root: string,
  attachmentsDir?: string,
) {
  const files: NonNullable<SessionPromptInput["files"]>[number][] = [];
  let totalBytes = 0;
  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "thread" ||
      (attachment.type === "path" && attachment.entryKind === "directory") ||
      (attachment.type === "file" && attachment.entryKind === "directory")
    )
      throw new Error("V2 directory/thread attachment requires prior canonical expansion.");
    const managed =
      attachment.type !== "path" && !(attachment.type === "file" && attachment.sourcePath);
    const filename =
      attachment.type === "path"
        ? attachment.path
        : attachment.type === "file" && attachment.sourcePath
          ? attachment.sourcePath
          : attachmentsDir
            ? resolveAttachmentPath({ attachmentsDir, attachment })
            : undefined;
    if (!filename) throw new Error("V2 attachment storage is unavailable.");
    const realRoot = await realpath(managed && attachmentsDir ? attachmentsDir : root);
    const realFile = await realpath(filename);
    const relative = path.relative(realRoot, realFile);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("V2 attachment escapes its authorized storage/workspace.");
    const verify = await captureV2MediaIdentity(realRoot, realFile);
    const file = await open(
      realFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await verify(file);
      if (
        !stat.isFile() ||
        stat.size > V2_MEDIA_FILE_BYTES ||
        totalBytes + stat.size > V2_MEDIA_TOTAL_BYTES
      )
        throw new Error("V2 attachment byte bound exceeded.");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw new Error("V2 attachment changed during read.");
      await verify(file);
      const data = buffer.subarray(0, bytesRead);
      totalBytes += bytesRead;
      const mime = attachment.mimeType;
      assertV2MediaFormat(data, mime);
      files.push({ uri: `data:${mime};base64,${data.toString("base64")}`, name: attachment.name });
    } finally {
      await file.close();
    }
  }
  return {
    files,
    digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    references: undefined as string | undefined,
  };
}

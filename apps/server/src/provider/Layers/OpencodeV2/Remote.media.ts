import { createHash } from "node:crypto";
import path from "node:path";
import type { ProviderSendTurnInput } from "@bigbud/contracts/orchestration/provider.ts";
import { prepareV2Media } from "./Runtime.media.ts";
import type { V2RemoteFiles } from "./Remote.files.ts";
import { V2_MEDIA_FILE_BYTES, V2_MEDIA_TOTAL_BYTES } from "./Media.limits.ts";
import { assertV2MediaFormat } from "./Media.formats.ts";

/** Stage native data URIs over authenticated RPC; no native file URL, host fetch or local-path fallback. */
export async function prepareV2RemoteMedia(
  input: ProviderSendTurnInput,
  remote: V2RemoteFiles,
  attachmentsDir?: string,
) {
  const files: Awaited<ReturnType<typeof prepareV2Media>>["files"] = [];
  const references: Record<string, unknown>[] = [];
  let total = 0;
  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "thread")
      throw new Error("V2 thread references require canonical expansion.");
    if (attachment.type === "path") {
      const absolute = path.posix.isAbsolute(attachment.path)
        ? attachment.path
        : path.posix.join(remote.root, attachment.path);
      const relative = path.posix.relative(remote.root, absolute);
      if (
        (!relative && attachment.entryKind !== "directory") ||
        relative === ".." ||
        relative.startsWith("../")
      )
        throw new Error("V2 remote reference escapes its workspace.");
      if (attachment.entryKind === "directory") {
        await remote.run({ action: "list", path: relative || "." });
        references.push({
          id: attachment.id,
          executionTargetId: remote.executionTargetId,
          path: absolute,
          entryKind: "directory",
        });
        continue;
      }
      const data = await remote.readBytes(relative, V2_MEDIA_FILE_BYTES);
      assertV2MediaFormat(data, attachment.mimeType);
      total += data.byteLength;
      files.push({
        uri: `data:${attachment.mimeType};base64,${data.toString("base64")}`,
        name: attachment.name,
      });
      references.push({
        id: attachment.id,
        executionTargetId: remote.executionTargetId,
        path: absolute,
        entryKind: "file",
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    } else {
      // Upload IDs refer to server-managed storage, not a remote sourcePath or native server path.
      const upload =
        attachment.type === "file" ? { ...attachment, sourcePath: undefined } : attachment;
      const staged = await prepareV2Media(
        { ...input, attachments: [upload] },
        attachmentsDir ?? "",
        attachmentsDir,
      );
      for (const file of staged.files) {
        files.push(file);
        total += Buffer.from(file.uri.split(",")[1]!, "base64").byteLength;
      }
      references.push({
        id: attachment.id,
        source: "managed-upload",
        name: attachment.name,
        digest: staged.digest,
      });
    }
    if (total > V2_MEDIA_TOTAL_BYTES) throw new Error("V2 remote media total byte bound exceeded.");
  }
  const metadata = JSON.stringify(references);
  return {
    files,
    references: metadata,
    digest: createHash("sha256")
      .update(JSON.stringify([files, references]))
      .digest("hex"),
  };
}

import path from "node:path";
import type { ProviderSendTurnInput } from "@bigbud/contracts/orchestration/provider.ts";
import { readManagedProviderAttachment } from "../../../attachments/providerAttachments.managed.ts";
import {
  attachmentDigest,
  type PreparedAttachment,
} from "../../../attachments/providerAttachments.ts";
import type { V2RemoteFiles } from "./Remote.files.ts";
import { V2_MEDIA_FILE_BYTES } from "./Media.limits.ts";
import { prepareV2AttachmentContent, type V2MediaOptions } from "./Runtime.media.content.ts";

/** Target-bound broker references plus supported content fallback, never a desktop-path guess. */
export async function prepareV2RemoteMedia(
  input: ProviderSendTurnInput,
  remote: V2RemoteFiles,
  attachmentsDir?: string,
  options: V2MediaOptions = {},
) {
  const prepared: PreparedAttachment[] = [];
  const references: object[] = [];
  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "thread")
      throw new Error("V2 thread references require canonical expansion.");
    if (attachment.type === "path") {
      const absolute = path.posix.resolve(remote.root, attachment.path);
      const relative = path.posix.relative(remote.root, absolute);
      if (
        (!relative && attachment.entryKind !== "directory") ||
        relative === ".." ||
        relative.startsWith("../")
      )
        throw new Error("V2 remote reference escapes its workspace.");
      if (attachment.entryKind === "directory") {
        if (!options.tools)
          throw new Error("V2 directory reference requires broker reading tools.");
        await remote.run({ action: "list", path: relative || "." });
      } else {
        const bytes = await remote.readBytes(relative, V2_MEDIA_FILE_BYTES);
        // Broker is the reachable reader; native local file URLs must never point at remote paths.
        prepared.push({ attachment, bytes });
      }
      references.push({
        id: attachment.id,
        executionTargetId: remote.executionTargetId,
        path: absolute,
        entryKind: attachment.entryKind,
      });
    } else {
      if (!attachmentsDir) throw new Error("V2 managed upload storage is unavailable.");
      prepared.push(
        await readManagedProviderAttachment(
          attachment,
          attachmentsDir,
          options.pathReachable === true,
        ),
      );
      references.push({ id: attachment.id, source: "managed-upload", name: attachment.name });
    }
  }
  const result = await prepareV2AttachmentContent(input.input ?? "", prepared, references, options);
  // Historical remote text-only admissions include the empty reference-list identity.
  return {
    ...result,
    references: JSON.stringify(references),
    digest: prepared.length || references.length ? result.digest : attachmentDigest([[], []]),
  };
}

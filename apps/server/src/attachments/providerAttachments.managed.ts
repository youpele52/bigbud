import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ChatAttachment } from "@bigbud/contracts/orchestration/orchestration.attachments.ts";
import { isLocalExecutionTargetId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import { resolveAttachmentPath } from "./attachmentStore.ts";
import { captureAttachmentIdentity } from "./providerAttachments.identity.ts";
import { prepareAttachmentContext, type PreparedAttachment } from "./providerAttachments.ts";

/** Synthetic remote-workspace tools cannot read host snapshots even when the runtime is local. */
export function canReadManagedProviderPaths(
  binding:
    | {
        readonly providerRuntimeExecutionTargetId?: string | undefined;
        readonly workspaceExecutionTargetId?: string | undefined;
        readonly executionTargetId?: string | undefined;
      }
    | undefined,
): boolean {
  return (
    isLocalExecutionTargetId(binding?.providerRuntimeExecutionTargetId) &&
    isLocalExecutionTargetId(binding?.workspaceExecutionTargetId ?? binding?.executionTargetId)
  );
}

/** Read only managed snapshots. Desktop sourcePath is provenance, not file-read authority. */
export async function readManagedProviderAttachment(
  attachment: ChatAttachment,
  attachmentsDir: string,
  pathReachable = true,
): Promise<PreparedAttachment> {
  const filename = resolveAttachmentPath({ attachment, attachmentsDir });
  if (!filename) throw new Error(`Invalid attachment id '${attachment.id}'. Reattach the file.`);
  const root = await realpath(attachmentsDir);
  const realFile = await realpath(filename);
  const relative = path.relative(root, realFile);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Attachment escapes managed storage.");
  // Preserve managed relative spelling beneath the canonical root. macOS /var is
  // an alias for /private/var; realpath alone must not hide symlinked entries inside storage.
  const canonicalName = path.join(root, path.relative(path.resolve(attachmentsDir), filename));
  const verify = await captureAttachmentIdentity(root, canonicalName);
  const handle = await open(
    canonicalName,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await verify(handle);
    const limit =
      attachment.type === "image" || attachment.mimeType.startsWith("image/")
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit || stat.size !== attachment.sizeBytes)
      throw new Error(
        `Attachment '${attachment.name}' is empty, changed, or exceeds its byte limit.`,
      );
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    await verify(handle);
    if (bytesRead !== stat.size) throw new Error("Attachment changed during read.");
    return {
      attachment,
      bytes: buffer.subarray(0, bytesRead),
      ...(pathReachable ? { path: realFile } : {}),
    };
  } finally {
    await handle.close();
  }
}

/** Common adapter preparation; native adapters retain their supported visual protocol. */
export async function prepareManagedAttachmentContext(
  prompt: string,
  attachments: readonly ChatAttachment[],
  attachmentsDir: string,
  pathReachable = true,
) {
  const prepared: PreparedAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.type === "path" || attachment.type === "thread") continue;
    prepared.push(await readManagedProviderAttachment(attachment, attachmentsDir, pathReachable));
  }
  const context = await prepareAttachmentContext(prompt, prepared);
  for (const { attachment, path } of prepared) {
    if (
      !path &&
      !attachment.mimeType.startsWith("image/") &&
      attachment.mimeType !== "application/pdf" &&
      context.unextractableIds.includes(attachment.id)
    )
      throw new Error(
        `Attachment '${attachment.name}' cannot be read on this execution target and text extraction is unavailable. Reattach a text-readable version.`,
      );
  }
  return { ...context, attachments: prepared };
}

import path from "node:path";
import { realpath } from "node:fs/promises";
import type { ProviderSendTurnInput } from "@bigbud/contracts/orchestration/provider.ts";
import { readManagedProviderAttachment } from "../../../attachments/providerAttachments.managed.ts";
import type { PreparedAttachment } from "../../../attachments/providerAttachments.ts";
import { prepareV2AttachmentContent, type V2MediaOptions } from "./Runtime.media.content.ts";

/** Local managed snapshots only; sourcePath never grants native or host read authority. */
export async function prepareV2Media(
  input: ProviderSendTurnInput,
  root: string,
  attachmentsDir?: string,
  options: V2MediaOptions = {},
) {
  const prepared: PreparedAttachment[] = [];
  const references: object[] = [];
  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "thread")
      throw new Error("V2 thread attachments require canonical expansion.");
    if (attachment.type === "path") {
      // Canonical workspace references stay tool references, not arbitrary native file URLs.
      const realRoot = await realpath(root);
      const filename = await realpath(path.resolve(root, attachment.path));
      const relative = path.relative(realRoot, filename);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error("V2 attachment reference escapes its workspace.");
      if (!options.tools)
        throw new Error("V2 workspace path attachment requires available reading tools.");
      references.push({ id: attachment.id, path: filename, entryKind: attachment.entryKind });
      continue;
    }
    if (!attachmentsDir)
      throw new Error("V2 attachment storage is unavailable. Reattach the file.");
    prepared.push(
      await readManagedProviderAttachment(
        attachment,
        attachmentsDir,
        options.pathReachable !== false,
      ),
    );
  }
  return prepareV2AttachmentContent(input.input ?? "", prepared, references, options);
}

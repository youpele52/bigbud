import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, link, unlink } from "node:fs/promises";
import path from "node:path";
import { Schema } from "effect";
import type { ProviderSendTurnInput } from "@bigbud/contracts/orchestration/provider.ts";
import { attachmentDigest } from "../../../attachments/providerAttachments.ts";
import { captureAttachmentIdentity } from "../../../attachments/providerAttachments.identity.ts";
import { canReadManagedProviderPaths } from "../../../attachments/providerAttachments.managed.ts";
import { prepareV2Media } from "./Runtime.media.ts";
import { V2_MEDIA_RESPONSE_BYTES } from "./Media.limits.ts";
import { assertV2ModelAvailable } from "./Runtime.model.availability.ts";
import { v2TurnModel } from "./Runtime.model.ts";
import { validateV2TurnInput } from "./Runtime.input.ts";
import type { V2IsolatedRuntimeOptions, V2RuntimeSession } from "./Runtime.types.ts";

const Prepared = Schema.Struct({
  request: Schema.String,
  binding: Schema.String,
  text: Schema.String,
  digest: Schema.String,
  files: Schema.Array(Schema.Struct({ uri: Schema.String, name: Schema.String })),
  references: Schema.optional(Schema.String),
});
export type V2PreparedAttachments = typeof Prepared.Type;

async function readPrepared(root: string, filename: string) {
  const verify = await captureAttachmentIdentity(root, filename);
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await verify(handle);
    if (info.size > V2_MEDIA_RESPONSE_BYTES)
      throw new Error("V2 prepared attachment bound exceeded.");
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    await verify(handle);
    if (bytesRead !== info.size) throw new Error("V2 prepared attachment identity changed.");
    return Schema.decodeUnknownSync(Prepared)(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
    );
  } finally {
    await handle.close();
  }
}

/** Immutable per-request preparation survives restart/replay without rerunning OCR or rereading sources. */
export async function prepareV2TurnAttachments(
  options: V2IsolatedRuntimeOptions,
  session: V2RuntimeSession,
  input: ProviderSendTurnInput,
  existing: boolean,
): Promise<V2PreparedAttachments | undefined> {
  validateV2TurnInput(session, input);
  if (!input.attachments?.length) return undefined;
  const request = attachmentDigest([
    input.input ?? "",
    input.attachments,
    input.modelSelection ?? null,
  ]);
  const binding = attachmentDigest([
    session.native.id,
    session.native.location.directory,
    session.storageIdentity,
    session.session.providerRuntimeExecutionTargetId ?? "local",
    session.session.workspaceExecutionTargetId ?? "local",
  ]);
  if (options.config.sharedService && !options.attachmentAdmissionsDir)
    throw new Error("V2 shared attachment preparation requires private bigbud admission storage.");
  const root =
    options.attachmentAdmissionsDir ??
    path.join(options.config.profileRoot, "bigbud-attachment-admissions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && info.mode & 0o077)
  )
    throw new Error("V2 prepared attachment storage is not private.");
  const filename = path.join(
    root,
    `${attachmentDigest([input.threadId, input.requestMessageId, input.learningJob ?? null])}.json`,
  );
  let saved: V2PreparedAttachments | undefined;
  try {
    saved = await readPrepared(root, filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (saved) {
    if (saved.binding !== binding)
      throw new Error("V2 attachment replay target binding changed; no automatic resend.");
    if (saved.request !== request)
      throw new Error("V2 attachment replay input changed; no automatic resend.");
    return saved;
  }
  if (existing)
    throw new Error(
      "V2 attachment preparation is missing for an existing admission; no automatic resend.",
    );
  const model = await assertV2ModelAvailable(
    session.lease.process.client,
    session.native.location.directory,
    v2TurnModel(session, input),
  );
  const mediaOptions = {
    nativeImages: model.capabilities.input.includes("image"),
    tools: Boolean(session.localTools || session.coding),
    pathReachable: canReadManagedProviderPaths(session.session),
  };
  let prepared;
  try {
    prepared = session.resources?.media
      ? await session.resources.media(input, mediaOptions)
      : await prepareV2Media(
          input,
          session.native.location.directory,
          options.attachmentsDir,
          mediaOptions,
        );
  } catch (error) {
    throw new Error(
      `V2 attachment preparation failed before admission: ${error instanceof Error ? error.message : "reattach a supported file"}`,
    );
  }
  const value: V2PreparedAttachments = {
    request,
    binding,
    text: prepared.text ?? input.input ?? "",
    digest: prepared.digest,
    files: prepared.files.map((file) => ({ uri: file.uri, name: file.name ?? "attachment" })),
    ...(prepared.references ? { references: prepared.references } : {}),
  };
  if (value.text.length + (value.references?.length ?? 0) > 120000)
    throw new Error("V2 prompt plus attachment context exceeds bound.");
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > V2_MEDIA_RESPONSE_BYTES)
    throw new Error("V2 prepared attachment bound exceeded.");
  const temporary = path.join(root, `.prepare-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await handle.close();
    await unlink(temporary);
  }
  const published = await readPrepared(root, filename);
  if (JSON.stringify(published) !== JSON.stringify(value))
    throw new Error("V2 immutable attachment preparation conflict.");
  return published;
}

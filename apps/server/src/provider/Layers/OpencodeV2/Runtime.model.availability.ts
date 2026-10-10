import type { ModelRef } from "@opencode/client";
import type { OpencodeV2Client } from "./Client.ts";
import { readV2NativeCatalog } from "./Catalog.native.ts";
import { V2HttpStatusError } from "./Client.errors.ts";
import { V2ResponseSizeError } from "./Client.response.ts";

/** Public browsing cannot admit a prompt: recheck exact native availability before journaling. */
export async function assertV2ModelAvailable(
  client: OpencodeV2Client,
  directory: string,
  requested: ModelRef,
  signal?: AbortSignal,
) {
  const catalog = await readV2NativeCatalog(client, directory, {
    requested,
    ...(signal ? { signal } : {}),
  }).catch((error: unknown) => {
    signal?.throwIfAborted();
    const location = JSON.stringify(directory.slice(0, 256) + (directory.length > 256 ? "…" : ""));
    const reason =
      error instanceof V2HttpStatusError
        ? `Native model.list returned HTTP ${error.status}`
        : error instanceof V2ResponseSizeError
          ? "Native model.list exceeded the response safety bound"
          : "Native model.list failed or timed out";
    throw new Error(
      `OpenCode v2 native model availability could not be verified. ${reason} for chat Location ${location}. Check the native OpenCode service and its access to this folder (including macOS Files and Folders permissions), or explicitly choose an accessible chat/project folder. No prompt or fallback was sent.`,
    );
  });
  if (catalog.location.directory !== directory || catalog.data.length > 10_000)
    throw new Error("V2 native model availability ownership or count rejected.");
  const model = catalog.data.find(
    (entry) => entry.providerID === requested.providerID && entry.id === requested.id,
  );
  if (
    !model?.enabled ||
    model.status === "deprecated" ||
    (requested.variant &&
      requested.variant !== "default" &&
      !model.variants.some(({ id }) => id === requested.variant))
  )
    throw new Error(
      "OpenCode v2 selected model/variant is not currently available. Connect/configure its exact subprovider in the dedicated V2 profile, then refresh. No prompt or fallback was sent.",
    );
  return model;
}

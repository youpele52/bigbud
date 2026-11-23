import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import type { ModelListOutput } from "@opencode/client";
import type { OpencodeV2Client } from "./Client.ts";
import { normalizeV2Catalog } from "./Catalog.ts";
import { v2NativeCompatibilityBinding } from "./NativeCompatibility.binding.ts";
import type { V2SharedConnection } from "./SharedService.descriptor.ts";

const MAX_LOCATIONS = 16;
const TTL_MS = 15 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 15_000;
const workspaces = new WeakMap<
  OpencodeV2Client,
  Map<
    string,
    {
      readonly refreshedAt: number;
      readonly models: ReadonlyArray<ServerProviderModel>;
    }
  >
>();

/** Learn only from already authorized native model reads, never activate another Location here. */
export function rememberV2WorkspaceCatalog(
  client: OpencodeV2Client,
  catalog: ModelListOutput,
  directory: string,
) {
  const binding = v2NativeCompatibilityBinding(client);
  if (!binding) return;
  let locations = workspaces.get(client);
  if (!locations) {
    locations = new Map();
    workspaces.set(client, locations);
  }
  const now = Date.now();
  const previous = locations.get(directory);
  if (previous && now - previous.refreshedAt < MIN_REFRESH_INTERVAL_MS) return;
  try {
    binding.assertCurrent();
    const models = normalizeV2Catalog(catalog, directory);
    locations.delete(directory);
    locations.set(directory, { models, refreshedAt: now });
    if (locations.size > MAX_LOCATIONS) locations.delete(locations.keys().next().value!);
  } catch {
    // A malformed catalog must not qualify effort or break independent model admission.
    locations.delete(directory);
  }
}

export function readCachedV2WorkspaceCatalog(
  client: OpencodeV2Client,
  connection: V2SharedConnection,
  directory: string,
) {
  const binding = v2NativeCompatibilityBinding(client);
  if (
    !binding ||
    binding.descriptor.generation !== connection.generation ||
    binding.descriptor.storageIdentity !== connection.storageIdentity ||
    binding.descriptor.registrationFile !== connection.registrationFile
  )
    return undefined;
  try {
    binding.assertCurrent();
  } catch {
    return undefined;
  }
  const entry = workspaces.get(client)?.get(directory);
  return entry && Date.now() - entry.refreshedAt < TTL_MS ? entry.models : undefined;
}

import { Schema } from "effect";
import { TrimmedNonEmptyString } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import { getSubProviderDisplayName } from "../../subProviderDisplayNames.ts";
import { boundV2Response } from "./Client.response.ts";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";

// The pinned native ModelsDev service uses this source too. Metadata only: never
// consume its packages, endpoints, headers, bodies, or credential environment names.
export const V2_PUBLIC_CATALOG_URL = "https://models.opencode.ai/api.json";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 10_000;
const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 30_000;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const DisplayName = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const PublicModel = Schema.Struct({
  id: Text,
  name: DisplayName,
  status: Schema.optional(Schema.String),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.String),
      output: Schema.Array(Schema.String),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
const PublicCatalog = Schema.Record(
  Schema.String,
  Schema.Struct({
    id: Text,
    name: DisplayName,
    models: Schema.Record(Schema.String, PublicModel),
  }),
);

/** Exact public identities for browsing, with unknown native variants/capabilities. */
export function normalizeV2PublicCatalog(value: unknown): ReadonlyArray<ServerProviderModel> {
  const catalog = Schema.decodeUnknownSync(PublicCatalog)(value);
  if (Object.keys(catalog).length > 1000) throw new Error("V2 public provider count rejected.");
  const result: ServerProviderModel[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const provider of Object.values(catalog)) {
    // Retired aliases are also excluded by the pinned native ModelsDevPlugin.
    if (["azure-cognitive-services", "google-vertex-anthropic"].includes(provider.id)) continue;
    const explicitIDs = new Set(Object.values(provider.models).map(({ id }) => id));
    for (const model of Object.values(provider.models)) {
      if (++count > MAX_MODELS) throw new Error("V2 public model count rejected.");
      if (
        model.status === "deprecated" ||
        [model.modalities?.input, model.modalities?.output].some(
          (types) => types?.length && !types.some((type) => type.startsWith("text")),
        )
      )
        continue;
      const identities = [
        { slug: model.id, name: model.name },
        ...Object.keys(model.experimental?.modes ?? {}).map((mode) => ({
          slug: `${model.id}-${mode}`,
          name: `${model.name} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`,
        })),
      ];
      for (const entry of identities) {
        // Some gateways publish both a mode and its explicit model entry.
        if (entry.slug !== model.id && explicitIDs.has(entry.slug)) continue;
        const key = JSON.stringify([provider.id, entry.slug]);
        if (
          seen.has(key) ||
          !provider.id.trim() ||
          !entry.slug.trim() ||
          result.length >= MAX_MODELS
        )
          throw new Error("V2 public catalog identity or count rejected.");
        seen.add(key);
        result.push({
          ...entry,
          subProviderID: provider.id,
          group: getSubProviderDisplayName(provider.name),
          isCustom: false,
          capabilities: null,
          availability: "requires-setup",
        });
      }
    }
  }
  return result;
}

/** Scoped single-flight cache with bounded retry; retain the last good catalog on outages. */
export function makeV2PublicCatalogLoader(
  fetchCatalog: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
) {
  let cached: ReadonlyArray<ServerProviderModel> = [];
  let nextRead = 0;
  let stale = false;
  let pending: Promise<{ models: ReadonlyArray<ServerProviderModel>; stale: boolean }> | undefined;
  return async () => {
    if (pending) return pending;
    if (now() < nextRead) return { models: cached, stale };
    pending = (async () => {
      try {
        const models = await runWithAbortableDeadline({
          operation: "V2 public catalog",
          timeoutMs: 5000,
          run: async (signal) => {
            const response = await fetchCatalog(V2_PUBLIC_CATALOG_URL, {
              signal,
              redirect: "error",
              credentials: "omit",
              headers: { accept: "application/json" },
            });
            if (!response.ok) throw new Error("V2 public catalog HTTP failure.");
            return normalizeV2PublicCatalog(await boundV2Response(response, MAX_BYTES).json());
          },
        });
        if (!models.length) throw new Error("V2 public catalog empty.");
        cached = models;
        stale = false;
        nextRead = now() + TTL_MS;
      } catch {
        stale = true;
        nextRead = now() + RETRY_MS;
      }
      return { models: cached, stale };
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Native names, custom IDs and variants win; missing public entries stay setup-only, never executable proof. */
export function mergeV2Catalogs(
  publicModels: ReadonlyArray<ServerProviderModel>,
  nativeModels: ReadonlyArray<ServerProviderModel>,
  nativeProviderNames: ReadonlyMap<string, string>,
): ReadonlyArray<ServerProviderModel> {
  const models = new Map(
    publicModels.map((model) => {
      const providerName = nativeProviderNames.get(model.subProviderID!);
      const entry = providerName
        ? { ...model, group: getSubProviderDisplayName(providerName) }
        : model;
      return [JSON.stringify([entry.subProviderID, entry.slug]), entry];
    }),
  );
  for (const model of nativeModels)
    models.set(JSON.stringify([model.subProviderID, model.slug]), model);
  return [...models.values()].toSorted(
    (a, b) =>
      Number(b.availability === "available") - Number(a.availability === "available") ||
      (a.group ?? "").localeCompare(b.group ?? "") ||
      a.name.localeCompare(b.name) ||
      a.slug.localeCompare(b.slug),
  );
}

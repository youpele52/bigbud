import { Schema } from "effect";

import { TrimmedNonEmptyString } from "../core/baseSchemas";

export const PluginMarketplaceId = Schema.Literal("openai-public");
export type PluginMarketplaceId = typeof PluginMarketplaceId.Type;

export const PluginId = TrimmedNonEmptyString;
export type PluginId = typeof PluginId.Type;

export const PluginAssetKey = Schema.Literals(["composerIcon", "logo", "logoDark"]);
export type PluginAssetKey = typeof PluginAssetKey.Type;

export const PluginComponent = Schema.Struct({
  kind: Schema.Literal("skill"),
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
});
export type PluginComponent = typeof PluginComponent.Type;

export const PluginPresentation = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  longDescription: Schema.optional(TrimmedNonEmptyString),
  developer: Schema.optional(TrimmedNonEmptyString),
  category: Schema.optional(TrimmedNonEmptyString),
  defaultPrompt: Schema.optional(TrimmedNonEmptyString),
  website: Schema.optional(TrimmedNonEmptyString),
  privacy: Schema.optional(TrimmedNonEmptyString),
  terms: Schema.optional(TrimmedNonEmptyString),
  assets: Schema.Struct({
    composerIcon: Schema.optional(TrimmedNonEmptyString),
    logo: Schema.optional(TrimmedNonEmptyString),
    logoDark: Schema.optional(TrimmedNonEmptyString),
  }),
});
export type PluginPresentation = typeof PluginPresentation.Type;

export const PluginCatalogItem = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString,
  version: Schema.optional(TrimmedNonEmptyString),
  commit: TrimmedNonEmptyString,
  /** Repository-relative package location from the reviewed catalog snapshot. */
  sourcePath: TrimmedNonEmptyString,
  presentation: PluginPresentation,
  components: Schema.Array(PluginComponent),
  compatibility: Schema.Literals(["compatible", "invalid", "unsupported-components"]),
  compatibilityReason: Schema.optional(TrimmedNonEmptyString),
});
export type PluginCatalogItem = typeof PluginCatalogItem.Type;

export const PluginInstallation = Schema.Struct({
  pluginId: PluginId,
  revision: TrimmedNonEmptyString,
  version: Schema.optional(TrimmedNonEmptyString),
  installedAt: TrimmedNonEmptyString,
});
export type PluginInstallation = typeof PluginInstallation.Type;

export const PluginSyncState = Schema.Struct({
  status: Schema.Literals(["fresh", "stale", "unavailable", "loading"]),
  commit: Schema.optional(TrimmedNonEmptyString),
  successfulSyncAt: Schema.optional(TrimmedNonEmptyString),
  lastAttemptedAt: Schema.optional(TrimmedNonEmptyString),
  failure: Schema.optional(TrimmedNonEmptyString),
});
export type PluginSyncState = typeof PluginSyncState.Type;

export const PluginCatalog = Schema.Struct({
  revision: Schema.String,
  sync: PluginSyncState,
  items: Schema.Array(PluginCatalogItem),
  installed: Schema.Array(PluginInstallation),
});
export type PluginCatalog = typeof PluginCatalog.Type;

export class PluginError extends Schema.TaggedErrorClass<PluginError>()("PluginError", {
  code: Schema.Literals([
    "unavailable",
    "stale-catalog",
    "not-found",
    "incompatible",
    "invalid-package",
    "already-installed",
    "not-installed",
    "conflict",
    "insufficient-disk",
    "internal",
  ]),
  message: TrimmedNonEmptyString,
}) {}

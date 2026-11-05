import type { ServerProviderModel } from "@bigbud/contracts";
import { Option } from "effect";

import {
  decodeAccount,
  decodeCatalog,
  decodeProfiles,
  isContributorModel,
  type MuseModelCatalogEntry,
} from "./Client.schema.ts";
import { assertMuseHostQualified, type MuseTransport } from "./Client.ts";

export const MUSE_CATALOG_PROVIDER_ID = "meta";

/**
 * Per-platform availability switch. Enablement amendment 2 (2026-10-29, user
 * decision): Muse is supported on macOS, Windows and Linux on user opt-in.
 * macOS is live-qualified (docs/validation/muse-provider-qualification-2026-10-29.md);
 * Windows and Linux are enabled on Meta's published platform support plus the
 * upstream-proven Windows launch/root handling, and still owe a live record
 * (docs/validation/muse-windows-linux-qualification-kit.md). Machine-level
 * safety is enforced at runtime instead of per platform: a host that cannot
 * enforce its OS sandbox is refused (Client.ts). Set a platform to false only
 * to withdraw it after a failed qualification; unknown platforms stay off.
 */
export const MUSE_PLATFORM_QUALIFICATION = {
  macos: true,
  windows: true,
  linux: true,
} as const;

export type MusePlatform = keyof typeof MUSE_PLATFORM_QUALIFICATION;

export function musePlatformForNode(platform: NodeJS.Platform): MusePlatform | undefined {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

const MUSE_PLATFORM_LABELS: Record<MusePlatform, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

export function isMusePlatformQualified(
  platform: NodeJS.Platform = process.platform,
  qualification: Readonly<Record<MusePlatform, boolean>> = MUSE_PLATFORM_QUALIFICATION,
): boolean {
  const musePlatform = musePlatformForNode(platform);
  return musePlatform !== undefined && qualification[musePlatform];
}

/** Unavailable reason for the current platform, or undefined when it is qualified. */
export function musePlatformGateReason(
  platform: NodeJS.Platform = process.platform,
  qualification: Readonly<Record<MusePlatform, boolean>> = MUSE_PLATFORM_QUALIFICATION,
): string | undefined {
  const musePlatform = musePlatformForNode(platform);
  if (musePlatform === undefined) {
    return `Muse Code is not qualified on platform '${platform}'; it is unavailable there.`;
  }
  return qualification[musePlatform]
    ? undefined
    : `Muse Code is currently withdrawn on ${MUSE_PLATFORM_LABELS[musePlatform]} after a failed qualification; it is unavailable there until a fix is verified.`;
}

/**
 * Human display name for a native Muse model ID, matching the style Meta
 * surfaces elsewhere (e.g. OpenCode's Meta group): `muse-spark-1.3` →
 * "Muse Spark 1.3", `muse-spark-1.3-contributor` → "Muse Spark 1.3
 * Contributor", `muse-wonder-1.0`/`muse-wonder` → "Muse Wonder" (the Wonder
 * line carries no version in its display name). The stable slug/wire ID is
 * never changed; this only labels it.
 */
export function formatMuseModelDisplayName(modelId: string): string {
  const parts = modelId
    .replace(/^muse-/, "")
    .split("-")
    .filter(Boolean);
  const family = parts.shift() ?? modelId;
  const contributor = parts.at(-1) === "contributor" ? parts.pop() : undefined;
  const version = parts.find((part) => /^\d+(\.\d+)*$/.test(part));
  const label = ["Muse", family.charAt(0).toUpperCase() + family.slice(1)];
  if (version && family !== "wonder") label.push(version);
  if (contributor) label.push("Contributor");
  return label.join(" ");
}

export function mapCatalogModel(entry: MuseModelCatalogEntry): ServerProviderModel {
  const efforts =
    entry.variants === undefined || entry.variants === "unknown"
      ? []
      : entry.variants.map((tier) => ({
          value: tier,
          label: tier,
          ...(entry.defaultReasoningEffort === tier ? { isDefault: true } : {}),
        }));
  return {
    slug: entry.modelId,
    // The native catalog's displayLabel is the raw ID today; format it here so
    // web, mobile and recency all inherit one label. A future native human
    // label (anything other than the raw ID) is kept as-is.
    name:
      entry.displayLabel && entry.displayLabel !== entry.modelId
        ? entry.displayLabel
        : formatMuseModelDisplayName(entry.modelId),
    isCustom: false,
    subProviderID: entry.providerId,
    contributorTraining: isContributorModel(entry.modelId),
    capabilities: {
      reasoningEffortLevels: efforts,
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
      effortMetadataStatus: efforts.length > 0 ? "verified-supported" : "unknown",
      effortMetadataOrigin: efforts.length > 0 ? "live" : "unknown",
    },
  };
}

export interface MuseDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly authStatus: "authenticated" | "unauthenticated" | "unknown";
  readonly authType?: string;
  readonly version?: string;
  readonly gateFailure?: string;
}

/**
 * Read-only discovery on a short-lived host: catalog + account + permission
 * catalog without creating a session. Rejects non-meta catalogs, ephemeral
 * durability and missing sessionMcp grants instead of reporting readiness.
 */
export async function discoverMuse(transport: MuseTransport): Promise<MuseDiscoveryResult> {
  const gateFailure = assertMuseHostQualified(transport);
  if (gateFailure) return { models: [], authStatus: "unknown", gateFailure };

  const catalogRaw = await transport.request("model/list", {});
  const catalog = decodeCatalog(catalogRaw);
  if (Option.isNone(catalog)) {
    return {
      models: [],
      authStatus: "unknown",
      gateFailure: "Muse model catalog could not be decoded.",
    };
  }
  if (catalog.value.providerId !== MUSE_CATALOG_PROVIDER_ID) {
    return {
      models: [],
      authStatus: "unknown",
      gateFailure: `Muse catalog provider '${catalog.value.providerId}' is not the qualified Meta catalog.`,
    };
  }

  let authStatus: MuseDiscoveryResult["authStatus"] = "unknown";
  let authType: string | undefined;
  try {
    const account = decodeAccount(await transport.request("account/read", {}));
    if (Option.isSome(account)) {
      // API-key lanes (envKey/apiKey) are an override of the browser-sign-in
      // milestone: report them so the adapter can reject with remediation
      // instead of silently billing a key. The label is never surfaced.
      authStatus = account.value.state === "loggedOut" ? "unauthenticated" : "authenticated";
      authType = account.value.state;
    }
  } catch {
    authStatus = "unknown";
  }

  try {
    const profiles = decodeProfiles(await transport.request("permissionProfile/list", {}));
    if (
      Option.isNone(profiles) ||
      !profiles.value.profiles.some((p) => p.profileId === ":ask-me" && p.available)
    ) {
      return {
        models: catalog.value.models.map(mapCatalogModel),
        authStatus,
        ...(authType ? { authType } : {}),
        gateFailure: "Muse permission catalog does not offer the qualified :ask-me profile.",
      };
    }
  } catch {
    return {
      models: catalog.value.models.map(mapCatalogModel),
      authStatus,
      ...(authType ? { authType } : {}),
      gateFailure: "Muse permission catalog could not be read.",
    };
  }

  return {
    models: catalog.value.models.map(mapCatalogModel),
    authStatus,
    ...(authType ? { authType } : {}),
    ...(transport.initializeResult.serverVersion
      ? { version: transport.initializeResult.serverVersion }
      : {}),
  };
}

/** True when the effective credential lane is an API key rather than native browser login. */
export function isApiKeyLane(authType: string | undefined): boolean {
  return authType === "envKey" || authType === "apiKey";
}

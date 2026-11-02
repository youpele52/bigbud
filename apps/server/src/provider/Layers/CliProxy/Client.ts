import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import type { ModelCapabilities } from "@bigbud/contracts/core/model";

import type { CliProxyConfig } from "./config.ts";
import { decodeCliProxyCapabilities } from "./Capabilities.ts";
import { stableCliProxyVersion } from "./Version.ts";

export interface CliProxyModel {
  readonly id: string;
  readonly name: string;
  readonly capabilities?: ModelCapabilities;
}

export type CliProxyClientErrorTag =
  | "HealthProbeFailed"
  | "AuthenticationFailed"
  | "CatalogRequestFailed"
  | "CatalogMalformed"
  | "ModelUnavailable";

export interface CliProxyClientErrorOptions extends ErrorOptions {
  readonly requestedModel?: string;
  readonly availableModels?: ReadonlyArray<string>;
}

export class CliProxyClientError extends Error {
  override readonly name = "CliProxyClientError";

  constructor(
    readonly _tag: CliProxyClientErrorTag,
    message: string,
    options?: CliProxyClientErrorOptions,
  ) {
    super(message, options);
    this.requestedModel = options?.requestedModel;
    this.availableModels = options?.availableModels;
  }

  readonly requestedModel: string | undefined;
  readonly availableModels: ReadonlyArray<string> | undefined;
}

export type CliProxyHttpRequest = (config: CliProxyConfig, pathname: string) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 2_000;
const CLIENT_PROFILE_VERSION = "0.1.0";
const inspectionFlightSecret = randomBytes(32);

function inspectionFlightKey(config: CliProxyConfig): string {
  const credentialIdentity = createHmac("sha256", inspectionFlightSecret)
    .update(config.apiKey)
    .digest("hex");
  return `${path.resolve(config.configPath)}\u0000${config.baseUrl.href}\u0000${credentialIdentity}`;
}

const defaultRequest: CliProxyHttpRequest = (config, pathname) =>
  fetch(new URL(pathname, config.baseUrl), {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

function catalogEntries(value: unknown): ReadonlyArray<unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: ReadonlyArray<unknown> }).data;
  }
  if (Array.isArray((value as { models?: unknown }).models)) {
    return (value as { models: ReadonlyArray<unknown> }).models;
  }
  return undefined;
}

export function decodeModels(value: unknown): ReadonlyArray<CliProxyModel> {
  const data = catalogEntries(value);
  if (!data) {
    throw new CliProxyClientError(
      "CatalogMalformed",
      "CLIProxyAPI model catalog did not contain a data or models array.",
    );
  }
  const seen = new Set<string>();
  return data.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new CliProxyClientError(
        "CatalogMalformed",
        `CLIProxyAPI model catalog entry ${index} was not an object.`,
      );
    }
    const entry = candidate as {
      id?: unknown;
      slug?: unknown;
      name?: unknown;
      display_name?: unknown;
      visibility?: unknown;
      supported_reasoning_levels?: unknown;
      default_reasoning_level?: unknown;
    };
    if (entry.visibility !== undefined && typeof entry.visibility !== "string") {
      throw new CliProxyClientError(
        "CatalogMalformed",
        `CLIProxyAPI model catalog entry ${index} has a non-string visibility.`,
      );
    }
    if (entry.visibility === "hidden" || entry.visibility === "hide") return [];
    const id =
      typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : typeof entry.slug === "string" && entry.slug.trim()
          ? entry.slug.trim()
          : undefined;
    if (!id) {
      throw new CliProxyClientError(
        "CatalogMalformed",
        `CLIProxyAPI model catalog entry ${index} did not contain a non-empty id or slug.`,
      );
    }
    if (entry.name !== undefined && typeof entry.name !== "string") {
      throw new CliProxyClientError(
        "CatalogMalformed",
        `CLIProxyAPI model catalog entry ${index} has a non-string name.`,
      );
    }
    if (entry.display_name !== undefined && typeof entry.display_name !== "string") {
      throw new CliProxyClientError(
        "CatalogMalformed",
        `CLIProxyAPI model catalog entry ${index} has a non-string display_name.`,
      );
    }
    if (seen.has(id)) return [];
    seen.add(id);
    const name =
      typeof entry.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim()
        : typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : id;
    const capabilities = decodeCliProxyCapabilities(
      entry.supported_reasoning_levels,
      entry.default_reasoning_level,
    );
    // Catalog labels may include a redundant minor version; wire IDs remain authoritative.
    const displayName = name.replace(/^(GPT[ -]\d+)\.0(?=\s|$)/i, "$1");
    return [{ id, name: displayName, ...(capabilities ? { capabilities } : {}) }];
  });
}

export function validateCliProxyModel(
  models: ReadonlyArray<CliProxyModel>,
  requestedModel: string,
): CliProxyModel {
  const normalizedModel = requestedModel.trim();
  const model = models.find((candidate) => candidate.id === normalizedModel);
  if (!model) {
    const availableModels = models.map((candidate) => candidate.id);
    const availableDetail =
      availableModels.length > 0 ? ` Available models: ${availableModels.join(", ")}.` : "";
    throw new CliProxyClientError(
      "ModelUnavailable",
      `CLIProxyAPI model '${requestedModel}' is not available for the Claude-compatible client profile.${availableDetail}`,
      { requestedModel, availableModels },
    );
  }
  return model;
}

export interface CliProxyInspection {
  readonly models: ReadonlyArray<CliProxyModel>;
  readonly runtimeVersion: string | null;
}

export async function inspectCliProxyDetails(
  config: CliProxyConfig,
  options: { readonly request?: CliProxyHttpRequest } = {},
): Promise<CliProxyInspection> {
  const request = options.request ?? defaultRequest;
  const key = inspectionFlightKey(config);
  const existing = inspectionFlights.get(key);
  if (existing) return existing;
  const flight = inspectCliProxyUncached(config, request).finally(() => {
    if (inspectionFlights.get(key) === flight) inspectionFlights.delete(key);
  });
  inspectionFlights.set(key, flight);
  return flight;
}

const inspectionFlights = new Map<string, Promise<CliProxyInspection>>();

/** Models-only API retained for runtime configuration and activation callers. */
export async function inspectCliProxy(
  config: CliProxyConfig,
  options: { readonly request?: CliProxyHttpRequest } = {},
): Promise<ReadonlyArray<CliProxyModel>> {
  return (await inspectCliProxyDetails(config, options)).models;
}

async function inspectCliProxyUncached(
  config: CliProxyConfig,
  request: CliProxyHttpRequest,
): Promise<CliProxyInspection> {
  let fingerprint: Response;
  try {
    fingerprint = await request(config, "/");
  } catch (cause) {
    throw new CliProxyClientError(
      "HealthProbeFailed",
      "CLIProxyAPI health probe could not be completed.",
      { cause },
    );
  }
  if (fingerprint.status === 401 || fingerprint.status === 403) {
    throw new CliProxyClientError(
      "AuthenticationFailed",
      `CLIProxyAPI health probe was rejected with HTTP ${fingerprint.status}.`,
    );
  }
  if (!fingerprint.ok || !(await fingerprint.text()).includes("CLI Proxy API Server")) {
    throw new CliProxyClientError(
      "HealthProbeFailed",
      "CLIProxyAPI health probe did not return the expected server response.",
    );
  }

  let response: Response;
  try {
    response = await request(config, `/v1/models?client_version=${CLIENT_PROFILE_VERSION}`);
  } catch (cause) {
    throw new CliProxyClientError(
      "CatalogRequestFailed",
      "CLIProxyAPI model catalog request could not be completed.",
      { cause },
    );
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CliProxyClientError(
        "AuthenticationFailed",
        `CLIProxyAPI model catalog request was rejected with HTTP ${response.status}.`,
      );
    }
    throw new CliProxyClientError(
      "CatalogRequestFailed",
      `CLIProxyAPI model catalog request failed with HTTP ${response.status}.`,
    );
  }
  try {
    const models = decodeModels(await response.json());
    // Stock releases may omit this header. Never probe protected management routes to obtain it.
    const catalogVersion = stableCliProxyVersion(response.headers.get("X-CPA-VERSION"));
    const healthVersion = stableCliProxyVersion(fingerprint.headers.get("X-CPA-VERSION"));
    const runtimeVersion =
      catalogVersion && healthVersion && catalogVersion !== healthVersion
        ? null
        : (catalogVersion ?? healthVersion);
    return { models, runtimeVersion };
  } catch (cause) {
    if (cause instanceof CliProxyClientError) throw cause;
    throw new CliProxyClientError(
      "CatalogMalformed",
      "CLIProxyAPI model catalog response was not valid JSON.",
      { cause },
    );
  }
}

export const probeCliProxy = inspectCliProxy;

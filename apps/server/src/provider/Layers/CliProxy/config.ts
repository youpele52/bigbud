import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

export interface CliProxyConfig {
  readonly baseUrl: URL;
  readonly apiKey: string;
  readonly configPath: string;
}

export type CliProxyConfigErrorTag =
  | "ConfigNotFound"
  | "ConfigUnreadable"
  | "ConfigMalformed"
  | "ConfigInvalidShape"
  | "UnsupportedProtocol"
  | "UnsafeAddress"
  | "InvalidPort"
  | "MissingCredential";

export class CliProxyConfigError extends Error {
  override readonly name = "CliProxyConfigError";

  constructor(
    readonly _tag: CliProxyConfigErrorTag,
    message: string,
    readonly configPath?: string,
    readonly field?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ParsedCliProxyConfig {
  readonly host?: string;
  readonly port?: string;
  readonly protocol?: string;
  readonly apiKeys: ReadonlyArray<string>;
  readonly tlsEnabled: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const WILDCARD_HOSTS = new Set(["", "*", "0.0.0.0", "::", "[::]"]);

function malformed(configPath: string, detail: string, cause?: unknown): CliProxyConfigError {
  return new CliProxyConfigError(
    "ConfigMalformed",
    `CLIProxyAPI config is malformed: ${detail}`,
    configPath,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function invalidShape(
  configPath: string,
  field: string,
  detail: string,
  cause?: unknown,
): CliProxyConfigError {
  return new CliProxyConfigError(
    "ConfigInvalidShape",
    `CLIProxyAPI config field '${field}' is invalid: ${detail}`,
    configPath,
    field,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldValue(
  documentValue: Record<string, unknown>,
  field: string,
  configPath: string,
): unknown {
  const value = documentValue[field];
  if (value === null) {
    throw invalidShape(configPath, field, "expected a scalar or mapping, not null.");
  }
  return value;
}

function scalarString(
  documentValue: Record<string, unknown>,
  field: string,
  configPath: string,
): string | undefined {
  const value = fieldValue(documentValue, field, configPath);
  if (value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw invalidShape(configPath, field, "expected a string or number.");
}

function parseYaml(content: string, configPath: string): Record<string, unknown> {
  let document;
  try {
    document = parseDocument(content, {
      prettyErrors: false,
      uniqueKeys: true,
    });
  } catch (cause) {
    throw malformed(configPath, cause instanceof Error ? cause.message : "invalid YAML.", cause);
  }
  if (document.errors.length > 0) {
    const error = document.errors[0]!;
    throw malformed(configPath, error.message, error);
  }
  let value: unknown;
  try {
    value = document.toJS();
  } catch (cause) {
    throw malformed(configPath, cause instanceof Error ? cause.message : "invalid YAML.", cause);
  }
  if (!isRecord(value)) {
    throw invalidShape(configPath, "<root>", "expected a YAML mapping.");
  }
  return value;
}

export function parseCliProxyConfig(
  content: string,
  configPath = "<memory>",
): ParsedCliProxyConfig {
  const documentValue = parseYaml(content, configPath);
  const host = scalarString(documentValue, "host", configPath);
  const port = scalarString(documentValue, "port", configPath);
  const protocol = scalarString(documentValue, "protocol", configPath);

  const rawApiKeysValue = documentValue["api-keys"];
  const apiKeysValue = rawApiKeysValue === null ? undefined : rawApiKeysValue;
  let apiKeys: ReadonlyArray<string> = [];
  if (apiKeysValue !== undefined) {
    if (!Array.isArray(apiKeysValue)) {
      throw malformed(configPath, "api-keys must be a YAML sequence of strings.");
    }
    apiKeys = apiKeysValue.map((value, index) => {
      if (typeof value !== "string") {
        throw invalidShape(configPath, `api-keys[${index}]`, "expected a string.");
      }
      return value;
    });
  }

  const tlsValue = fieldValue(documentValue, "tls", configPath);
  let tlsEnabled = false;
  if (tlsValue !== undefined) {
    if (!isRecord(tlsValue)) {
      throw invalidShape(configPath, "tls", "expected a YAML mapping.");
    }
    const enabled = tlsValue.enable;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      if (enabled !== "true" && enabled !== "false") {
        throw invalidShape(configPath, "tls.enable", "expected true or false.");
      }
      tlsEnabled = enabled === "true";
    } else if (enabled !== undefined) {
      tlsEnabled = enabled;
    }
  }

  return {
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(protocol === undefined ? {} : { protocol }),
    apiKeys,
    tlsEnabled,
  };
}

function normalizeHost(host: string, configPath: string): string {
  const withoutBrackets = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (WILDCARD_HOSTS.has(host) || WILDCARD_HOSTS.has(withoutBrackets)) return "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(withoutBrackets)) {
    throw new CliProxyConfigError(
      "UnsafeAddress",
      `CLIProxyAPI host '${host}' is not a local loopback address.`,
      configPath,
      "host",
    );
  }
  return withoutBrackets;
}

function buildBaseUrl(parsed: ParsedCliProxyConfig, configPath: string): URL {
  const portText = parsed.port ?? "8317";
  if (!/^\d+$/u.test(portText)) {
    throw new CliProxyConfigError(
      "InvalidPort",
      `Invalid CLIProxyAPI port '${portText}'.`,
      configPath,
      "port",
    );
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CliProxyConfigError(
      "InvalidPort",
      `Invalid CLIProxyAPI port '${portText}'.`,
      configPath,
      "port",
    );
  }
  const host = normalizeHost(parsed.host ?? "127.0.0.1", configPath);
  const configuredProtocol = parsed.protocol?.toLowerCase().replace(/:$/u, "");
  if (
    configuredProtocol !== undefined &&
    configuredProtocol !== "http" &&
    configuredProtocol !== "https"
  ) {
    throw new CliProxyConfigError(
      "UnsupportedProtocol",
      `Unsupported CLIProxyAPI protocol '${parsed.protocol}'.`,
      configPath,
      "protocol",
    );
  }
  const protocol = `${configuredProtocol ?? (parsed.tlsEnabled ? "https" : "http")}:`;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`${protocol}//${urlHost}:${port}`);
}

function defaultConfigCandidates(options: ResolveCliProxyConfigOptions): ReadonlyArray<string> {
  const homebrewCandidates =
    options.homebrewConfigPath !== undefined
      ? [options.homebrewConfigPath]
      : process.platform === "darwin"
        ? ["/opt/homebrew/etc/cliproxyapi.conf", "/usr/local/etc/cliproxyapi.conf"]
        : [];
  return [
    ...homebrewCandidates,
    path.join(options.homeDirectory ?? os.homedir(), ".cli-proxy-api", "config.yaml"),
    path.join(options.workingDirectory ?? process.cwd(), "config.yaml"),
  ];
}

export interface ResolveCliProxyConfigOptions {
  readonly exists?: (candidate: string) => boolean;
  readonly readFile?: (candidate: string) => string;
  readonly homeDirectory?: string;
  readonly workingDirectory?: string;
  readonly homebrewConfigPath?: string;
}

export function resolveCliProxyConfig(
  configPath?: string,
  options: ResolveCliProxyConfigOptions = {},
): CliProxyConfig {
  const exists = options.exists ?? existsSync;
  const candidates = configPath ? [configPath] : defaultConfigCandidates(options);
  const selectedPath = candidates.find((candidate) => exists(candidate));
  if (!selectedPath) {
    throw new CliProxyConfigError(
      "ConfigNotFound",
      configPath
        ? `CLIProxyAPI config was not found at '${configPath}'.`
        : "CLIProxyAPI config was not found in any supported location.",
      configPath,
    );
  }

  let content: string;
  try {
    content = (options.readFile ?? ((candidate) => readFileSync(candidate, "utf8")))(selectedPath);
  } catch (cause) {
    throw new CliProxyConfigError(
      "ConfigUnreadable",
      `CLIProxyAPI config at '${selectedPath}' could not be read.`,
      selectedPath,
      undefined,
      { cause },
    );
  }

  const parsed = parseCliProxyConfig(content, selectedPath);
  const apiKey = parsed.apiKeys.find((candidate) => candidate.trim().length > 0)?.trim();
  if (!apiKey) {
    throw new CliProxyConfigError(
      "MissingCredential",
      "CLIProxyAPI config does not contain a usable api-keys credential.",
      selectedPath,
      "api-keys",
    );
  }

  return Object.freeze({
    baseUrl: buildBaseUrl(parsed, selectedPath),
    apiKey,
    configPath: selectedPath,
  });
}

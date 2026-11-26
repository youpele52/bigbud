import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  isTrustedRemoteExecutablePath,
  type OpencodeV2ServiceBinding,
} from "./sshOwnerRemotePath.ts";

/**
 * Why the profile settings do not yield a usable OpenCode v2 binding. An unset
 * remote path is not a refusal (the owner discovers the executable); a set but
 * non-absolute `remoteBinaryPath` is `non-absolute-path`, and a settings file
 * that exists but cannot be read or parsed is `settings-unreadable`.
 */
export type DevOpencodeV2ServiceRefusal =
  | "no-binding"
  | "non-absolute-path"
  | "settings-unreadable";

export interface DevProviderServices {
  readonly providerService?: { readonly kind: "pi" | "codex"; readonly binaryPath: string };
  readonly opencodeV2Service?: OpencodeV2ServiceBinding;
  /**
   * A configured-but-unusable v2 binding stays typed-refused instead of becoming
   * an absent binding, so the composition can report the exact reason.
   */
  readonly opencodeV2Refusal?: DevOpencodeV2ServiceRefusal;
}

function absolute(value: unknown): string | undefined {
  return isTrustedRemoteExecutablePath(value) ? value : undefined;
}

function remoteSettingsValue(value: unknown): unknown {
  const remote =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).remoteBinaryPath
      : undefined;
  // An empty string means "not set", matching the trimmed settings default.
  return remote === "" ? undefined : remote;
}

async function readProviderServicesFile(file: string): Promise<DevProviderServices> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // No settings file: nothing is configured, so the owner discovers.
    const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return missing ? { opencodeV2Service: {} } : { opencodeV2Refusal: "settings-unreadable" };
  }
  try {
    const raw: unknown = JSON.parse(text);
    const providers =
      raw && typeof raw === "object" && "providers" in raw
        ? ((raw as { providers?: unknown }).providers as Record<string, unknown> | undefined)
        : undefined;
    const pi = absolute(
      providers && typeof providers.pi === "object" && providers.pi !== null
        ? (providers.pi as { binaryPath?: unknown }).binaryPath
        : undefined,
    );
    // `binaryPath` is the LOCAL executable; only `remoteBinaryPath` names a
    // remote one. Without it the owner discovers the executable per target.
    const remoteRaw = remoteSettingsValue(providers?.opencodeV2);
    const remote = remoteRaw === undefined ? undefined : absolute(remoteRaw);
    return {
      ...(pi ? { providerService: { kind: "pi" as const, binaryPath: pi } } : {}),
      ...(remoteRaw === undefined
        ? { opencodeV2Service: {} }
        : remote === undefined
          ? { opencodeV2Refusal: "non-absolute-path" as const }
          : { opencodeV2Service: { binaryPath: remote } }),
    };
  } catch {
    return { opencodeV2Refusal: "settings-unreadable" };
  }
}

/**
 * The dev domain binds the provider service to the configured remote executables
 * from the disposable profile's settings. A relative or missing setting keeps the
 * provider refused instead of admitting a caller-chosen program.
 */
export async function readDevProviderServices(
  profile: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<DevProviderServices> {
  if (platform !== "linux" || !profile) return {};
  return readProviderServicesFile(path.join(profile, "dev", "settings.json"));
}

/**
 * Production launch binding for the owner's OpenCode v2 lane, read from the
 * server's own settings file the same way the dev domain reads its profile.
 * Only the trusted absolute executable reaches the owner argv; the owner lane
 * exists on macOS and Linux initiating hosts.
 */
export async function readProductionOpencodeV2Service(
  settingsPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Pick<DevProviderServices, "opencodeV2Service" | "opencodeV2Refusal">> {
  if (platform !== "linux" && platform !== "darwin") return {};
  // A configured-but-unusable `remoteBinaryPath` keeps its typed refusal so
  // production reports the exact reason instead of a generic `no-binding`.
  const { opencodeV2Service, opencodeV2Refusal } = await readProviderServicesFile(settingsPath);
  return {
    ...(opencodeV2Service === undefined ? {} : { opencodeV2Service }),
    ...(opencodeV2Refusal === undefined ? {} : { opencodeV2Refusal }),
  };
}

import { readFile } from "node:fs/promises";
import path from "node:path";

import { isTrustedRemoteExecutablePath } from "./sshOwnerRemotePath.ts";

/**
 * Why the profile settings do not yield a usable OpenCode v2 executable. A
 * missing settings file is simply unconfigured (`no-binding`); a settings file
 * that exists but cannot be read or parsed is `settings-unreadable`.
 */
export type DevOpencodeV2ServiceRefusal =
  | "no-binding"
  | "non-absolute-path"
  | "settings-unreadable";

export interface DevProviderServices {
  readonly providerService?: { readonly kind: "pi" | "codex"; readonly binaryPath: string };
  readonly opencodeService?: { readonly binaryPath: string };
  readonly opencodeV2Service?: { readonly binaryPath: string };
  /**
   * A configured-but-unusable v2 binding stays typed-refused instead of becoming
   * an absent binding, so the composition can report the exact reason.
   */
  readonly opencodeV2Refusal?: DevOpencodeV2ServiceRefusal;
}

function absolute(value: unknown): string | undefined {
  return isTrustedRemoteExecutablePath(value) ? value : undefined;
}

function settingsValue(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).binaryPath
    : undefined;
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
  let text: string;
  try {
    text = await readFile(path.join(profile, "dev", "settings.json"), "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return { opencodeV2Refusal: missing ? "no-binding" : "settings-unreadable" };
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
    const opencode = absolute(settingsValue(providers?.opencode));
    const opencodeV2Raw = settingsValue(providers?.opencodeV2);
    const opencodeV2 = opencodeV2Raw === undefined ? undefined : absolute(opencodeV2Raw);
    return {
      ...(pi ? { providerService: { kind: "pi" as const, binaryPath: pi } } : {}),
      ...(opencode ? { opencodeService: { binaryPath: opencode } } : {}),
      ...(opencodeV2 ? { opencodeV2Service: { binaryPath: opencodeV2 } } : {}),
      ...(opencodeV2Raw === undefined
        ? { opencodeV2Refusal: "no-binding" as const }
        : opencodeV2 === undefined
          ? { opencodeV2Refusal: "non-absolute-path" as const }
          : {}),
    };
  } catch {
    return { opencodeV2Refusal: "settings-unreadable" };
  }
}

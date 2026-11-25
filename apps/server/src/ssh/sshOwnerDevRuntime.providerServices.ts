import { readFile } from "node:fs/promises";
import path from "node:path";

export interface DevProviderServices {
  readonly providerService?: { readonly kind: "pi" | "codex"; readonly binaryPath: string };
  readonly opencodeService?: { readonly binaryPath: string };
}

function absolute(value: unknown): string | undefined {
  return typeof value === "string" && path.posix.isAbsolute(value) && !value.includes("\0")
    ? value
    : undefined;
}

/**
 * The dev domain binds the provider service to the configured remote executables
 * from the disposable profile's settings. A relative or missing setting keeps the
 * provider refused instead of admitting a caller-chosen program.
 */
export async function readDevProviderServices(
  profile: string | undefined,
): Promise<DevProviderServices> {
  if (process.platform !== "linux" || !profile) return {};
  try {
    const raw: unknown = JSON.parse(
      await readFile(path.join(profile, "dev", "settings.json"), "utf8"),
    );
    const providers =
      raw && typeof raw === "object" && "providers" in raw
        ? ((raw as { providers?: unknown }).providers as Record<string, unknown> | undefined)
        : undefined;
    const pi = absolute(
      providers && typeof providers.pi === "object" && providers.pi !== null
        ? (providers.pi as { binaryPath?: unknown }).binaryPath
        : undefined,
    );
    const opencode = absolute(
      providers && typeof providers.opencode === "object" && providers.opencode !== null
        ? (providers.opencode as { binaryPath?: unknown }).binaryPath
        : undefined,
    );
    return {
      ...(pi ? { providerService: { kind: "pi" as const, binaryPath: pi } } : {}),
      ...(opencode ? { opencodeService: { binaryPath: opencode } } : {}),
    };
  } catch {
    return {};
  }
}

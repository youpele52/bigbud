import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Organisation has no Electron/delivery enable gate. The server owns this child. */
export function organizationNativeBinary(
  environment: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const name =
    process.platform === "win32" ? "bigbud-desktop-supervisor.exe" : "bigbud-desktop-supervisor";
  const explicit =
    environment.BIGBUD_THREAD_ORGANIZATION_BINARY?.trim() ||
    environment.BIGBUD_DESKTOP_SUPERVISOR_BINARY?.trim();
  if (explicit) return exists(explicit) ? explicit : undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "organization-supervisor", `${process.platform}-${process.arch}`, name),
    join(here, "delivery-supervisor", "bin", name),
    join(here, "..", "..", "dist", "delivery-supervisor", "bin", name),
    join(here, "..", "..", "..", "..", "target", "debug", name),
  ];
  return candidates.find(exists);
}

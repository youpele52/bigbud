import type { DesktopWindowMaterial } from "@bigbud/contracts/core/settings.ts";
import type { ResolvedWindowMaterial } from "@bigbud/contracts/server/ipc.windowMaterial.ts";

interface WindowMaterialSystem {
  readonly platform: string;
  readonly systemVersion: string;
  readonly reducedTransparency: boolean;
  readonly highContrast: boolean;
}

export function resolveWindowMaterial(
  mode: DesktopWindowMaterial,
  system: WindowMaterialSystem,
): ResolvedWindowMaterial {
  if (system.platform !== "darwin" || mode === "solid") return "solid";
  if (mode === "translucent") return "translucent";

  const majorVersion = Number(system.systemVersion.split(".")[0]);
  return majorVersion >= 26 && !system.reducedTransparency && !system.highContrast
    ? "translucent"
    : "solid";
}

export function getSafeWindowMaterial(value: unknown): DesktopWindowMaterial | null {
  return value === "automatic" || value === "solid" || value === "translucent" ? value : null;
}

export function isWindowMaterialRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

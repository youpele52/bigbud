import type { DesktopWindowMaterial } from "../core/settings";

export type ResolvedWindowMaterial = "solid" | "translucent";

/** The window's selected mode and the material actually applied by Electron. */
export interface DesktopWindowMaterialState {
  readonly mode: DesktopWindowMaterial;
  readonly material: ResolvedWindowMaterial;
  /** Echoes the renderer request; retained across system preference updates. */
  readonly requestId?: string;
}

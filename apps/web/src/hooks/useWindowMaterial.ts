import { useEffect, useMemo } from "react";
import type { DesktopWindowMaterial } from "@bigbud/contracts/settings";
import { isElectron } from "../config/env";
import { isMacPlatform } from "../lib/utils";
import { useSettings } from "./useSettings";

export type ResolvedWindowMaterial = "solid" | "translucent";

export function isMacDesktopWindowMaterialSupported(): boolean {
  return isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
}

export function resolveDesktopWindowMaterial(
  windowMaterial: DesktopWindowMaterial,
  isMacDesktop: boolean,
): ResolvedWindowMaterial {
  if (!isMacDesktop) {
    return "solid";
  }

  return windowMaterial === "solid" ? "solid" : "translucent";
}

export function useWindowMaterial() {
  const { windowMaterial } = useSettings();
  const isMacDesktop = isMacDesktopWindowMaterialSupported();
  const resolvedWindowMaterial = useMemo(
    () => resolveDesktopWindowMaterial(windowMaterial, isMacDesktop),
    [isMacDesktop, windowMaterial],
  );

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) {
      return;
    }

    void bridge.setWindowMaterial(windowMaterial).catch(() => undefined);
  }, [windowMaterial]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.desktopShell = isMacDesktop ? "macos" : "default";
    root.dataset.windowMaterial = resolvedWindowMaterial;
    root.dataset.windowMaterialMode = windowMaterial;
  }, [isMacDesktop, resolvedWindowMaterial, windowMaterial]);

  return {
    isMacDesktop,
    resolvedWindowMaterial,
    windowMaterial,
  } as const;
}

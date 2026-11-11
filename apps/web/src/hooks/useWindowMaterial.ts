import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { DesktopWindowMaterialState } from "@bigbud/contracts/server/ipc.windowMaterial.ts";
import { isElectron } from "../config/env";
import { isMacPlatform } from "../lib/utils";
import { useSettings } from "./useSettings";
import { syncWindowMaterial } from "./useWindowMaterial.sync";

export function isMacDesktopWindowMaterialSupported(): boolean {
  return isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
}

export function useWindowMaterial() {
  const { windowMaterial } = useSettings();
  const isMacDesktop = isMacDesktopWindowMaterialSupported();
  // Selecting the same mode again still requires a fresh native confirmation.
  const request = useMemo(() => ({ mode: windowMaterial }), [windowMaterial]);
  const [applied, setApplied] = useState<{
    request: typeof request;
    state: DesktopWindowMaterialState;
  } | null>(null);
  const resolvedWindowMaterial =
    isMacDesktop && applied?.request === request ? applied.state.material : "solid";

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) {
      return;
    }

    return syncWindowMaterial(bridge, request.mode, (state) => setApplied({ request, state }));
  }, [request]);

  useLayoutEffect(() => {
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

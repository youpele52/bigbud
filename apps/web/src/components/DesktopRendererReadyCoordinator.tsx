import type { DesktopRendererReadyAction } from "@bigbud/contracts/server/ipc.ts";
import { useEffect, useRef } from "react";

export function DesktopRendererReadyCoordinator() {
  const didNotifyRef = useRef(false);

  useEffect(() => {
    if (didNotifyRef.current) return;
    didNotifyRef.current = true;
    const action: DesktopRendererReadyAction = {
      type: "desktop-renderer-ready",
      role: "main",
    };
    window.desktopBridge?.sendMenuAction?.(action);
  }, []);

  return null;
}

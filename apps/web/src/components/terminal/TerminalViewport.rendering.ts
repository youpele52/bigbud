import type { Terminal } from "@xterm/xterm";
import type { TerminalGpuAcceleration } from "@bigbud/contracts/core/settings.ts";
import type { TerminalRenderingPolicy } from "@bigbud/contracts/server/ipc.terminal";
import { isElectron } from "~/config/env";
import {
  TerminalRendererController,
  type TerminalRendererState,
} from "./TerminalRendererController";

/** Visibility owns GPU resources, not emulator lifetime. Unknown desktop policy stays DOM. */
export function attachTerminalRenderer(
  terminal: Terminal,
  mount: HTMLElement,
  onState: (state: TerminalRendererState) => void,
) {
  const controller = new TerminalRendererController(terminal, onState);
  let setting: TerminalGpuAcceleration = "off";
  let ownerVisible = true;
  let intersecting = true;
  let disposed = false;
  let revision = 0;
  let knownPolicy: TerminalRenderingPolicy | null = null;
  const sync = (deliberateRetry = false) => {
    if (disposed) return;
    const current = ++revision;
    const bounds = mount.getBoundingClientRect();
    const visible =
      ownerVisible &&
      intersecting &&
      document.visibilityState !== "hidden" &&
      bounds.width >= 32 &&
      bounds.height >= 32;
    if (!visible || setting === "off") {
      knownPolicy = null;
      controller.update(setting, visible, null);
      return;
    }
    if (!isElectron) {
      controller.update(setting, visible, {
        allowed: true,
        reason: null,
        webglFeatureStatus: "browser-probe",
      });
      if (deliberateRetry) controller.retry();
      return;
    }
    if (!knownPolicy) controller.update(setting, visible, null);
    void window.desktopBridge
      ?.getTerminalRenderingPolicy?.()
      .then((policy: TerminalRenderingPolicy) => {
        if (!disposed && current === revision) {
          knownPolicy = policy;
          controller.update(setting, visible, policy);
          if (deliberateRetry) controller.retry();
        }
      })
      .catch(() => {
        if (!disposed && current === revision) {
          knownPolicy = null;
          controller.update(setting, visible, null);
        }
      });
  };
  const refresh = () => sync();
  const resize = new ResizeObserver(refresh);
  resize.observe(mount);
  const intersection = new IntersectionObserver((entries) => {
    intersecting = entries[0]?.isIntersecting ?? false;
    refresh();
  });
  intersection.observe(mount);
  document.addEventListener("visibilitychange", refresh);
  return {
    update(next: TerminalGpuAcceleration, visible = true) {
      if (setting !== next) knownPolicy = null;
      setting = next;
      ownerVisible = visible;
      refresh();
    },
    retry() {
      sync(true);
    },
    dispose() {
      disposed = true;
      revision++;
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", refresh);
      controller.dispose();
    },
  };
}

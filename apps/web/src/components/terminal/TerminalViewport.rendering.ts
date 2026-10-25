import type { Terminal } from "@xterm/xterm";
import type { TerminalGpuAcceleration } from "@bigbud/contracts/core/settings.ts";
import type { TerminalRenderingPolicy } from "@bigbud/contracts/server/ipc.terminal";
import { isElectron } from "~/config/env";
import { gateTerminalRenderingPolicy } from "./terminalWebglProbe";
import {
  TerminalRendererController,
  type TerminalRendererState,
} from "./TerminalRendererController";

const POLICY_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/** A not-yet-observed GPU status is re-queried with bounded backoff, not only on resize. */
function isPolicyPending(policy: TerminalRenderingPolicy): boolean {
  return !policy.allowed && policy.webglFeatureStatus === "unknown";
}

/**
 * Visibility owns GPU resources, output pacing and cursor blinking, not emulator lifetime.
 * Unknown desktop policy stays DOM.
 */
export function attachTerminalRenderer(
  terminal: Terminal,
  mount: HTMLElement,
  onState: (state: TerminalRendererState) => void,
  onVisibility: (visible: boolean) => void = () => undefined,
) {
  const controller = new TerminalRendererController(terminal, onState);
  let lastVisible: boolean | null = null;
  const reportVisibility = (visible: boolean) => {
    if (visible === lastVisible) return;
    lastVisible = visible;
    // A hidden view's blink timer would keep repainting an invisible (possibly retained) canvas.
    if (terminal.options.cursorBlink !== visible) terminal.options.cursorBlink = visible;
    onVisibility(visible);
  };
  let setting: TerminalGpuAcceleration = "off";
  let ownerVisible = true;
  let intersecting = true;
  let disposed = false;
  let revision = 0;
  let knownPolicy: TerminalRenderingPolicy | null = null;
  let policyRetry: ReturnType<typeof setTimeout> | null = null;
  let policyRetryAttempt = 0;
  const clearPolicyRetry = () => {
    if (policyRetry !== null) clearTimeout(policyRetry);
    policyRetry = null;
  };
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
    reportVisibility(visible);
    if (!visible || setting === "off") {
      knownPolicy = null;
      controller.update(setting, visible, null);
      return;
    }
    if (!isElectron) {
      controller.update(
        setting,
        visible,
        gateTerminalRenderingPolicy({
          allowed: true,
          reason: null,
          webglFeatureStatus: "browser-probe",
        }),
      );
      if (deliberateRetry) controller.retry();
      return;
    }
    if (!knownPolicy) controller.update(setting, visible, null);
    void window.desktopBridge
      ?.getTerminalRenderingPolicy?.()
      .then((reported: TerminalRenderingPolicy) => {
        if (!disposed && current === revision) {
          const policy = gateTerminalRenderingPolicy(reported);
          knownPolicy = policy;
          controller.update(setting, visible, policy);
          if (deliberateRetry) controller.retry();
          const delay = POLICY_RETRY_DELAYS_MS[policyRetryAttempt];
          if (isPolicyPending(policy) && policyRetry === null && delay !== undefined) {
            policyRetryAttempt++;
            policyRetry = setTimeout(() => {
              policyRetry = null;
              knownPolicy = null;
              sync();
            }, delay);
          }
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
      if (setting !== next) {
        knownPolicy = null;
        policyRetryAttempt = 0;
      }
      setting = next;
      ownerVisible = visible;
      refresh();
    },
    retry() {
      sync(true);
    },
    reattach() {
      controller.reattach();
    },
    dispose() {
      disposed = true;
      revision++;
      clearPolicyRetry();
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", refresh);
      controller.dispose();
    },
  };
}

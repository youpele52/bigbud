import { isElectron } from "~/config/env";

import type { BrowserAnnotationTheme } from "./BrowserPanel.annotation";
import type { ElectronWebview } from "./BrowserPanel.viewport.types";

function probeColor(cssValue: string, property: "color" | "backgroundColor"): string {
  if (typeof document === "undefined") return cssValue;
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  probe.style.visibility = "hidden";
  if (property === "color") {
    probe.style.color = cssValue;
  } else {
    probe.style.backgroundColor = cssValue;
  }
  document.body.appendChild(probe);
  const resolved =
    property === "color" ? getComputedStyle(probe).color : getComputedStyle(probe).backgroundColor;
  probe.remove();
  if (!resolved || resolved === "rgba(0, 0, 0, 0)" || resolved === "transparent") return cssValue;
  return resolved;
}

function readElementColor(
  element: Element | null,
  property: "backgroundColor" | "borderColor" | "color",
): string | undefined {
  if (!element) return undefined;
  const value = getComputedStyle(element)[property];
  return value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent" ? value : undefined;
}

export function readAnnotationTheme(): BrowserAnnotationTheme {
  const styles = getComputedStyle(document.documentElement);
  const composerForm = document.querySelector('[data-chat-composer-form="true"]');
  const composerSurface = composerForm?.querySelector(".bg-card") ?? composerForm ?? null;
  const composerEditor = composerForm?.querySelector('[data-testid="composer-editor"]') ?? null;
  const composerSendButton =
    composerForm?.querySelector<HTMLButtonElement>("button[type=submit]") ??
    composerForm?.querySelector<HTMLButtonElement>("button.bg-primary\\/90") ??
    null;

  const rawCard = styles.getPropertyValue("--card").trim() || "var(--color-white)";
  const rawFg = styles.getPropertyValue("--foreground").trim() || "var(--color-neutral-900)";
  const rawBorder = styles.getPropertyValue("--border").trim() || "rgba(0,0,0,0.08)";
  const rawInput = styles.getPropertyValue("--input").trim() || "rgba(0,0,0,0.1)";
  const rawMuted = styles.getPropertyValue("--muted-foreground").trim() || "#737373";
  const rawPrimary = styles.getPropertyValue("--primary").trim() || "var(--brand-primary-dark)";
  const rawPrimaryFg =
    styles.getPropertyValue("--primary-foreground").trim() || "var(--brand-primary-light)";
  const rawInfo = styles.getPropertyValue("--info-foreground").trim() || "#1d4ed8";
  const rawRing = styles.getPropertyValue("--ring").trim() || "var(--foreground)";

  return {
    card:
      readElementColor(composerSurface, "backgroundColor") ??
      probeColor(rawCard, "backgroundColor"),
    foreground: readElementColor(composerEditor, "color") ?? probeColor(rawFg, "color"),
    border: readElementColor(composerSurface, "borderColor") ?? probeColor(rawBorder, "color"),
    input: probeColor(rawInput, "backgroundColor"),
    mutedForeground: probeColor(rawMuted, "color"),
    primary:
      readElementColor(composerSendButton, "backgroundColor") ??
      probeColor(rawPrimary, "backgroundColor"),
    primaryForeground:
      readElementColor(composerSendButton, "color") ?? probeColor(rawPrimaryFg, "color"),
    infoForeground: probeColor(rawInfo, "color"),
    ring: probeColor(rawRing, "color"),
  };
}

export function isWebviewTagSupported(): boolean {
  if (!isElectron) return false;
  try {
    const wv = document.createElement("webview");
    return typeof (wv as ElectronWebview).getWebContentsId === "function";
  } catch {
    return false;
  }
}

export function isWebviewReady(webview: ElectronWebview): boolean {
  try {
    const id = webview.getWebContentsId();
    return typeof id === "number" && Number.isFinite(id);
  } catch {
    return false;
  }
}

export function runIfReady(
  webview: ElectronWebview | null,
  ready: boolean,
  action: (webview: ElectronWebview) => void,
): void {
  if (!webview || !ready) return;
  try {
    action(webview);
  } catch {
    // Ignore transient webview errors.
  }
}

export function normalizeBrowserUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

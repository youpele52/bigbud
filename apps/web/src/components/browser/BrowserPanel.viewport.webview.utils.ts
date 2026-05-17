import { isElectron } from "~/config/env";

import type { BrowserAnnotationTheme } from "./BrowserPanel.annotation";
import type { ElectronWebview } from "./BrowserPanel.viewport.types";

export const browserSameTabPopupGuardScript = String.raw`(() => {
  const navigateCurrentTab = (rawUrl) => {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      return false;
    }

    try {
      const nextUrl = new URL(rawUrl, window.location.href).toString();
      window.location.assign(nextUrl);
      return true;
    } catch {
      return false;
    }
  };

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      const targetValue = anchor.getAttribute("target");
      if (targetValue !== "_blank") {
        return;
      }

      if (!navigateCurrentTab(anchor.href)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  const originalWindowOpen = window.open.bind(window);
  window.open = function patchedWindowOpen(url, target, features) {
    if (typeof target === "string" && target.length > 0 && target !== "_self" && target !== "_top") {
      if (navigateCurrentTab(String(url ?? ""))) {
        return window;
      }
    }

    if (navigateCurrentTab(String(url ?? ""))) {
      return window;
    }

    return originalWindowOpen(url, target, features);
  };
})();`;

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

export function normalizeBrowserUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

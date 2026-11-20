import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Deep-link targets on Settings › AI, reached as `/settings/ai#<id>` like the existing
 * `#text-generation-model` link (`AiSettingsSection`, `MetadataWarningToastCoordinator`).
 */
export const SETTINGS_ANCHORS = {
  searchThisComputer: "search-this-computer",
  fileAccessPermissionLevel: "file-access-permission-level",
} as const;
export type SettingsAnchorId = (typeof SETTINGS_ANCHORS)[keyof typeof SETTINGS_ANCHORS];

/** How long a linked-to row stays highlighted. */
export const SETTINGS_ANCHOR_HIGHLIGHT_MS = 1_600;
/** The row's own control first (not an inline link in its description). */
const CONTROLS = [
  "[role='switch']",
  "[role='combobox']",
  "input, select",
  "button:not([disabled])",
];

/**
 * Makes the settings row with `id={anchorId}` a deep-link target: when the URL hash names it,
 * the row scrolls into view, its control takes focus (without a second scroll) and it is
 * highlighted briefly. Returns whether the row is the current target, so it can stay visible
 * during an unrelated settings search (`SettingsRow forceVisible`).
 */
export function useSettingsAnchorTarget(anchorId: SettingsAnchorId): boolean {
  const location = useLocation();
  const targeted = location.hash === anchorId;
  useEffect(() => {
    if (!targeted) return;
    const row = document.getElementById(anchorId);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    const control = CONTROLS.map((selector) => row.querySelector<HTMLElement>(selector)).find(
      (candidate) => candidate !== null,
    );
    control?.focus({ preventScroll: true });
    row.setAttribute("data-settings-highlighted", "");
    const timer = setTimeout(
      () => row.removeAttribute("data-settings-highlighted"),
      SETTINGS_ANCHOR_HIGHLIGHT_MS,
    );
    return () => {
      clearTimeout(timer);
      row.removeAttribute("data-settings-highlighted");
    };
    // `location` changes on every navigation, so following the same link twice re-highlights.
  }, [targeted, anchorId, location]);
  return targeted;
}

/** An inline, keyboard-accessible link to another setting on Settings › AI. */
export function SettingsAnchorLink({
  anchorId,
  children,
}: {
  anchorId: SettingsAnchorId;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="text-xs text-foreground underline underline-offset-2 hover:text-foreground/80 focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => void navigate({ to: "/settings/ai", hash: anchorId })}
    >
      {children}
    </button>
  );
}

import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import type { HistoryState } from "@tanstack/react-router";

export type MobileNavigationView =
  | { readonly kind: "chats" }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "settings" };

export interface MobileNavigationHistoryState extends HistoryState {
  readonly mobileOverlay?: unknown;
}

export function parseMobileNavigationView(state: unknown): MobileNavigationView | null {
  if (!state || typeof state !== "object") return null;
  const overlay = (state as { mobileOverlay?: unknown }).mobileOverlay;
  if (!overlay || typeof overlay !== "object") return null;
  const candidate = overlay as { kind?: unknown; projectId?: unknown };
  if (candidate.kind === "chats") return { kind: "chats" };
  if (candidate.kind === "settings") return { kind: "settings" };
  if (candidate.kind === "project" && typeof candidate.projectId === "string") {
    return { kind: "project", projectId: candidate.projectId };
  }
  return null;
}

export function withMobileNavigationView(
  state: MobileNavigationHistoryState,
  view: MobileNavigationView,
): MobileNavigationHistoryState {
  return { ...state, mobileOverlay: view };
}

export function withoutMobileNavigationView(
  state: MobileNavigationHistoryState,
): MobileNavigationHistoryState {
  const next = { ...state };
  delete next.mobileOverlay;
  return next;
}

export function sanitizeMobileBackendOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function describeMobileConnection(state: MobileRecoveryState): string {
  if (state.freshness === "current") return "Connection current";
  if (state.freshness === "refreshing") return "Refreshing chats";
  if (state.freshness === "stale") return "Connection stale; showing last-known data";
  if (state.freshness === "legacy") return "Connection limited; cached data may be behind";
  return "Unable to connect";
}

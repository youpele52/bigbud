import type { SidebarThreadSummary } from "~/models/types";
import { isSessionHealthUnconfirmed } from "~/logic/session";

const STORAGE_KEY = "bigbud:games-work-toast:v1";
export const GAMES_WORK_THRESHOLD_MS = 600_000;

type Marker = { threadId: string; turnId: string; shown: boolean };

export function readGamesWorkMarkers(storage: Pick<Storage, "getItem">): Marker[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is Marker =>
            entry !== null &&
            typeof entry === "object" &&
            typeof entry.threadId === "string" &&
            typeof entry.turnId === "string" &&
            typeof entry.shown === "boolean",
        )
      : [];
  } catch {
    return [];
  }
}

export function saveGamesWorkMarkers(storage: Pick<Storage, "setItem">, markers: Marker[]): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(markers));
}

/** A missing or uncertain projection cannot terminate a known period. */
export function reconcileGamesWorkMarkers(
  markers: Marker[],
  summaries: readonly SidebarThreadSummary[],
): Marker[] {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  return markers.filter((marker) => {
    const summary = byId.get(marker.threadId as SidebarThreadSummary["id"]);
    if (!summary) return true;
    const turn = summary.latestTurn;
    if (turn?.turnId === marker.turnId && turn.state !== "running") return false;
    if (summary.session && !isSessionHealthUnconfirmed(summary.session)) {
      if (summary.session.status === "closed" || summary.session.status === "error") return false;
      if (summary.session.activeTurnId && summary.session.activeTurnId !== marker.turnId)
        return false;
    }
    return true;
  });
}

export function gamesWorkDueAt(summary: SidebarThreadSummary): number | null {
  const session = summary.session;
  const turn = summary.latestTurn;
  if (
    !session ||
    session.status !== "running" ||
    isSessionHealthUnconfirmed(session) ||
    !session.activeTurnId ||
    turn?.turnId !== session.activeTurnId ||
    turn.state !== "running" ||
    !turn.startedAt
  )
    return null;
  const start = Date.parse(turn.startedAt);
  return Number.isFinite(start) ? start + GAMES_WORK_THRESHOLD_MS + 1 : null;
}

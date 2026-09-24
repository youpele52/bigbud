import { describe, expect, it } from "vitest";
import { PROVIDER_RECOVERING_SESSION_REASON, ThreadId, TurnId } from "@bigbud/contracts";
import type { SidebarThreadSummary } from "~/models/types";
import {
  GAMES_WORK_THRESHOLD_MS,
  gamesWorkDueAt,
  readGamesWorkMarkers,
  reconcileGamesWorkMarkers,
  saveGamesWorkMarkers,
} from "./gamesWorkToast.logic";

const startedAt = "2026-09-24T00:00:00.000Z";
function summary(
  turnId = "turn-1",
  state: "running" | "completed" | "error" | "interrupted" = "running",
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    session: { status: "running", activeTurnId: TurnId.makeUnsafe(turnId), reason: null },
    latestTurn: { turnId: TurnId.makeUnsafe(turnId), state, startedAt },
  } as SidebarThreadSummary;
}

describe("Games work period", () => {
  it("starts at the canonical turn start and triggers strictly after ten minutes", () => {
    const due = gamesWorkDueAt(summary());
    expect(due).toBe(Date.parse(startedAt) + GAMES_WORK_THRESHOLD_MS + 1);
    expect(due! - 1).toBe(Date.parse(startedAt) + GAMES_WORK_THRESHOLD_MS);
  });

  it("preserves the shown marker through missing data and recovery; resets at authoritative ends or a new turn", () => {
    const marker = [{ threadId: "thread-1", turnId: "turn-1", shown: true }];
    expect(
      reconcileGamesWorkMarkers(marker, [{ ...summary(), latestTurn: null, session: null }]),
    ).toEqual(marker);
    expect(
      reconcileGamesWorkMarkers(marker, [
        {
          ...summary(),
          session: {
            ...summary().session!,
            status: "ready",
            reason: PROVIDER_RECOVERING_SESSION_REASON,
            activeTurnId: undefined,
          },
        },
      ]),
    ).toEqual(marker);
    expect(
      reconcileGamesWorkMarkers(marker, [
        { ...summary(), session: { ...summary().session!, status: "closed" } },
      ]),
    ).toEqual([]);
    for (const state of ["completed", "error", "interrupted"] as const)
      expect(reconcileGamesWorkMarkers(marker, [summary("turn-1", state)])).toEqual([]);
    expect(reconcileGamesWorkMarkers(marker, [summary("turn-2")])).toEqual([]);
  });

  it("persists shown markers and survives malformed storage", () => {
    let value = "";
    const storage = {
      getItem: () => value,
      setItem: (_: string, next: string) => {
        value = next;
      },
    };
    const marker = [{ threadId: "thread-1", turnId: "turn-1", shown: true }];
    saveGamesWorkMarkers(storage, marker);
    expect(readGamesWorkMarkers(storage)).toEqual(marker);
    value = "broken";
    expect(readGamesWorkMarkers(storage)).toEqual([]);
  });
});

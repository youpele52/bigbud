import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "~/stores/main";
import { toastManager } from "../ui/toast";
import {
  gamesWorkDueAt,
  readGamesWorkMarkers,
  reconcileGamesWorkMarkers,
  saveGamesWorkMarkers,
} from "./gamesWorkToast.logic";

export function GamesWorkToastCoordinator() {
  const navigate = useNavigate();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (timer) clearTimeout(timer);
      const storage = window.localStorage;
      const summaries = Object.values(useStore.getState().sidebarThreadsById);
      const previous = readGamesWorkMarkers(storage);
      const markers = reconcileGamesWorkMarkers(previous, summaries);
      let nextDue: number | null = null;
      for (const summary of summaries) {
        const dueAt = gamesWorkDueAt(summary);
        if (dueAt === null) continue;
        const turnId = summary.session!.activeTurnId!;
        if (
          markers.some(
            (marker) => marker.threadId === summary.id && marker.turnId === turnId && marker.shown,
          )
        )
          continue;
        if (Date.now() >= dueAt) {
          markers.push({ threadId: summary.id, turnId, shown: true });
          try {
            saveGamesWorkMarkers(storage, markers);
          } catch {
            /* Best effort when storage is unavailable. */
          }
          toastManager.add({
            type: "info",
            title: "Your agent is still working",
            description: "Take a break with a game while it continues.",
            actionProps: { children: "Games", onClick: () => void navigate({ to: "/games" }) },
          });
        } else nextDue = Math.min(nextDue ?? dueAt, dueAt);
      }
      if (JSON.stringify(markers) !== JSON.stringify(previous)) {
        try {
          saveGamesWorkMarkers(storage, markers);
        } catch {
          /* The app continues if storage is full. */
        }
      }
      if (nextDue !== null) timer = setTimeout(update, Math.max(1, nextDue - Date.now()));
    };
    update();
    const unsubscribe = useStore.subscribe(update);
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [navigate]);
  return null;
}

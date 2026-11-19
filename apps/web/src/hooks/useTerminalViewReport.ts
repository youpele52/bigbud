import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { visibleTerminalIds } from "../logic/terminal/terminalView.logic";
import { readNativeApi } from "../rpc/nativeApi";
import { useTerminalStateStore } from "../stores/terminal";
import { useTerminalPanelStore } from "../stores/terminal/terminalPanel.store";

/** Clients refresh before the server's 2-minute view lease ends. */
const REFRESH_MS = 45_000;

/**
 * Tells the server which thread and panes this window shows, so finished work in a viewed pane
 * never raises attention, and opening the thread or viewing a pane clears its finished items.
 * A hidden or unfocused window views nothing.
 */
export function useTerminalViewReport(threadId: ThreadId) {
  const panelOpen = useTerminalPanelStore((state) => state.open);
  const terminalIds = useTerminalStateStore(
    useShallow((state) =>
      visibleTerminalIds({
        drawer: state.terminalStateByThreadId[threadId],
        panel: state.panelTerminalStateByThreadId[threadId],
        panelOpen,
      }),
    ),
  );
  const paneKey = terminalIds.join("\u0000");
  useEffect(() => {
    const send = (viewing: boolean) => {
      const view = readNativeApi()?.terminal.view;
      if (!view) return;
      void view(
        viewing
          ? { threadId, terminalIds: paneKey ? paneKey.split("\u0000") : [] }
          : { threadId: null, terminalIds: [] },
      ).catch(() => {});
    };
    const visible = () => document.visibilityState === "visible" && document.hasFocus();
    const report = () => send(visible());
    report();
    const timer = setInterval(() => {
      if (visible()) send(true);
    }, REFRESH_MS);
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      send(false);
    };
  }, [threadId, paneKey]);
}

import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { TERMINAL_VIEW_REFRESH_MS } from "@bigbud/contracts/workspace/terminal.activity.ts";
import { useEffect } from "react";
import { terminalViewRegistry } from "../components/terminal/view-registry/TerminalViewRegistry";
import { readNativeApi } from "../rpc/nativeApi";

/**
 * Tells the server which panes of the open thread this window shows, so finished work in a viewed
 * pane never raises attention and the host never treats a viewed terminal as hidden (plan §14
 * lease). A pane is **visible** only while `document.visibilityState === "visible"` and its view
 * is attached to an on-screen slot: not the parking holder, not inside an inert or hidden
 * subtree. Re-reported on `visibilitychange`, on every attach and release, and on a refresh timer
 * that also renews the lease.
 */
export function useTerminalViewReport(threadId: ThreadId) {
  useEffect(() => {
    // No DOM (non-browser rendering such as tests): there is no viewer to report.
    if (typeof document === "undefined" || typeof window === "undefined") return;
    let lastKey: string | null = null;
    const send = (terminalIds: readonly string[] | null) => {
      const view = readNativeApi()?.terminal?.view;
      if (!view) return;
      void view(
        terminalIds
          ? { threadId, terminalIds: [...terminalIds] }
          : { threadId: null, terminalIds: [] },
      ).catch(() => {});
    };
    const current = () =>
      document.visibilityState === "visible"
        ? terminalViewRegistry.visibleTerminalIds(threadId)
        : null;
    const report = (force: boolean) => {
      const terminalIds = current();
      const key = terminalIds ? terminalIds.join("\u0000") : null;
      if (!force && key === lastKey) return;
      lastKey = key;
      send(terminalIds);
    };
    const onChange = () => report(false);
    report(true);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") report(true);
    }, TERMINAL_VIEW_REFRESH_MS);
    document.addEventListener("visibilitychange", onChange);
    // Attach and release happen inside React commits; re-measure after layout settles.
    let frame: number | null = null;
    const unsubscribe = terminalViewRegistry.subscribeChanges(() => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        report(false);
      });
    });
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onChange);
      unsubscribe();
      if (frame !== null) window.cancelAnimationFrame(frame);
      send(null);
    };
  }, [threadId]);
}

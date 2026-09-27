import type {
  MonitorProcessPage,
  MonitorProcessQuery,
} from "@bigbud/contracts/system-monitor/types";
import { useEffect, useState } from "react";

import type { ProcessQueryControls } from "./ProcessTable";
import { buildProcessQuery } from "./processQuery.logic";

const INITIAL_CONTROLS: ProcessQueryControls = {
  search: "",
  status: "",
  sort: "cpu",
  descending: true,
};
type Cursor = NonNullable<MonitorProcessQuery["cursor"]>;

export function useProcessPage(enabled: boolean) {
  const [controls, setControls] = useState(INITIAL_CONTROLS);
  const [debounced, setDebounced] = useState(controls);
  const [cursors, setCursors] = useState<(Cursor | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<MonitorProcessPage | null>(null);
  const [status, setStatus] = useState("warming");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(controls), 250);
    return () => clearTimeout(timer);
  }, [controls]);

  useEffect(() => {
    setCursors([undefined]);
    setPageIndex(0);
    setPage(null);
  }, [debounced]);

  useEffect(() => {
    if (!enabled) return;
    const api = window.desktopBridge;
    if (!api?.systemMonitorQuery) {
      setStatus("unavailable");
      return;
    }
    let active = true;
    const request = async () => {
      setStatus("warming");
      const query = buildProcessQuery(debounced, cursors[pageIndex]);
      try {
        const result = await api.systemMonitorQuery!(query);
        if (active) {
          setPage(result);
          setStatus("ready");
        }
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Process query unavailable";
        if (message.toLowerCase().includes("stale") && pageIndex > 0) {
          setCursors([undefined]);
          setPageIndex(0);
        } else setStatus(message);
      }
    };
    void request();
    const timer = setInterval(() => {
      if (pageIndex === 0) void request();
    }, 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, debounced, cursors, pageIndex]);

  const next = () => {
    if (!page || page.nextOffset <= 0) return;
    const cursor = {
      generation: page.generation,
      digest: page.nextDigest,
      offset: page.nextOffset,
    };
    setCursors((current) => [...current.slice(0, pageIndex + 1), cursor]);
    setPageIndex((current) => current + 1);
  };
  const previous = () => setPageIndex((current) => Math.max(0, current - 1));

  return {
    controls,
    setControls,
    page,
    status,
    next,
    previous,
    hasNextPage: Boolean(page && page.nextOffset > 0),
    hasPreviousPage: pageIndex > 0,
  };
}

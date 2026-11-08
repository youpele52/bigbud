import type { DatabaseCompactionPreview } from "@bigbud/contracts/server/databaseCompaction.ts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureNativeApi } from "../../rpc/nativeApi";
import {
  publishCompactionStartedToast,
  publishDatabaseCompactionStatus,
  useDatabaseCompactionRunState,
} from "./DatabaseCompaction.runState";

/**
 * The Settings row's view of database compaction: the preview it shows, and `start`. Run status
 * (and the loader) is app-wide, owned by `DatabaseCompactionCoordinator`.
 */
export function useDatabaseCompaction() {
  const { status, reconnecting, statusUnavailable } = useDatabaseCompactionRunState();
  const [preview, setPreview] = useState<DatabaseCompactionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const running = status?.state === "running";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewSequenceRef.current += 1;
    };
  }, []);

  const refreshPreview = useCallback(async () => {
    const sequence = previewSequenceRef.current + 1;
    previewSequenceRef.current = sequence;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const next = await ensureNativeApi().server.previewDatabaseCompaction({});
      if (!mountedRef.current || sequence !== previewSequenceRef.current) return null;
      setPreview(next);
      return next;
    } catch (error) {
      if (!mountedRef.current || sequence !== previewSequenceRef.current) return null;
      setPreviewError(error instanceof Error ? error.message : "Failed to read the database size.");
      return null;
    } finally {
      if (mountedRef.current && sequence === previewSequenceRef.current) setPreviewBusy(false);
    }
  }, []);

  // Measure once the status is known and again whenever a run ends; never while one runs
  // (VACUUM holds the write connection, so the preview would only queue behind it).
  const statusKnown = status !== null || statusUnavailable;
  useEffect(() => {
    if (statusKnown && !running) void refreshPreview();
  }, [statusKnown, running, refreshPreview]);

  const start = useCallback(async () => {
    const next = await ensureNativeApi().server.startDatabaseCompaction({});
    publishCompactionStartedToast();
    publishDatabaseCompactionStatus(next);
  }, []);

  return {
    status,
    running,
    reconnecting,
    preview,
    previewError,
    previewBusy,
    refreshPreview,
    start,
  };
}

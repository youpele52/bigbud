/**
 * App-wide state of the database rebuild ("Compact database"). One store, fed by
 * `useDatabaseCompactionRunPolling` (mounted once, at the app root, by
 * `DatabaseCompactionCoordinator`) and by the Settings row when it starts a run, so the
 * full-panel loader appears wherever the user is, including after a reload mid-run.
 *
 * Every window learns about a run, wherever it was started: the status (in memory on the server,
 * so cheap) is re-read on every WebSocket (re)connect, when the window becomes visible, and on a
 * slow idle poll while visible; while a run is active it is polled every second.
 */
import type {
  DatabaseCompactionRun,
  DatabaseCompactionStatus,
} from "@bigbud/contracts/server/databaseCompaction.ts";
import { useEffect, useSyncExternalStore } from "react";

import { ensureNativeApi } from "../../rpc/nativeApi";
import { useWsConnectionStatus } from "../../rpc/wsConnectionState";
import { toastManager } from "../ui/toast";
import { compactionRunKey, getCompactionRunToast } from "./DatabaseCompaction.logic";

const TOASTED_RUN_KEY = "bigbud.databaseCompaction.toastedRun";
const POLL_MS = 1_000;
const RECONNECT_POLL_MS = 2_000;
/** While idle: how often a visible window checks whether a run started elsewhere. */
const IDLE_POLL_MS = 20_000;
/** An idle read that has not answered by then is abandoned, so the next one can go out. */
const IDLE_READ_TIMEOUT_MS = 15_000;
let idlePollMs = IDLE_POLL_MS;
let idleRead: Promise<void> | null = null;
/** Bumped by every published status, so an idle read that raced a newer one is dropped. */
let statusVersion = 0;

export interface DatabaseCompactionRunState {
  readonly status: DatabaseCompactionStatus | null;
  /** The server stopped answering while a run was active; the loader stays up. */
  readonly reconnecting: boolean;
  /** The startup status read failed, so `status` may stay null. */
  readonly statusUnavailable: boolean;
}

const INITIAL_STATE: DatabaseCompactionRunState = {
  status: null,
  reconnecting: false,
  statusUnavailable: false,
};
let state = INITIAL_STATE;
const listeners = new Set<() => void>();
let activeToastId: ReturnType<typeof toastManager.add> | null = null;

function setRunState(next: DatabaseCompactionRunState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Records a status the caller already has (for example, the one `start` returned). */
export function publishDatabaseCompactionStatus(status: DatabaseCompactionStatus): void {
  statusVersion += 1;
  setRunState({ status, reconnecting: false, statusUnavailable: false });
}

/** Tests only. */
export function resetDatabaseCompactionRunState(): void {
  activeToastId = null;
  idleRead = null;
  idlePollMs = IDLE_POLL_MS;
  setRunState(INITIAL_STATE);
}

/** Tests only: shortens the idle poll. */
export function setDatabaseCompactionIdlePollMsForTests(ms: number): void {
  idlePollMs = ms;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useDatabaseCompactionRunState(): DatabaseCompactionRunState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

function readToastedRun(): string | null {
  try {
    return window.localStorage.getItem(TOASTED_RUN_KEY);
  } catch {
    return null;
  }
}

function storeToastedRun(key: string): void {
  try {
    window.localStorage.setItem(TOASTED_RUN_KEY, key);
  } catch {
    /* Browser storage may be unavailable. */
  }
}

/** Blue while it runs. */
export function publishCompactionStartedToast(): void {
  const payload = { type: "loading" as const, title: "Compacting the database…", timeout: 0 };
  if (activeToastId === null) activeToastId = toastManager.add(payload);
  else toastManager.update(activeToastId, payload);
}

/** Green, amber or red once it ends; each finished run is announced once. */
export function publishCompactionRunToast(run: DatabaseCompactionRun): void {
  const key = compactionRunKey(run);
  if (readToastedRun() === key) {
    // Another window already announced it; close this window's blue toast instead.
    if (activeToastId !== null) toastManager.close(activeToastId);
    activeToastId = null;
    return;
  }
  storeToastedRun(key);
  const payload = { ...getCompactionRunToast(run), timeout: 10_000 };
  if (activeToastId === null) toastManager.add(payload);
  else toastManager.update(activeToastId, payload);
  activeToastId = null;
}

/** Publishes a status read and announces a run this window had not seen start or end. */
function applyStatus(next: DatabaseCompactionStatus): void {
  const wasRunning = state.status?.state === "running";
  publishDatabaseCompactionStatus(next);
  if (next.state === "running") {
    if (!wasRunning) publishCompactionStartedToast();
  } else if (next.lastRun) {
    publishCompactionRunToast(next.lastRun);
  }
}

/** One status read at a time outside an active run; overlapping triggers share it. */
function readStatusWhileIdle(): Promise<void> {
  if (idleRead) return idleRead;
  const version = statusVersion;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const read = Promise.race([
    ensureNativeApi().server.getDatabaseCompactionStatus({}),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Status read timed out.")), IDLE_READ_TIMEOUT_MS);
    }),
  ])
    .then((next) => {
      if (statusVersion === version) applyStatus(next);
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
      if (idleRead === read) idleRead = null;
    });
  idleRead = read;
  return read;
}

const pageVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Reads the status on mount (announcing a run that ended while nobody watched, including a
 * crash) and on every WebSocket (re)connect; while idle, re-reads it on a slow poll and when the
 * window becomes visible, so a run started in another window or before a backend restart shows
 * its loader here too; while a run is active, polls every second.
 */
export function useDatabaseCompactionRunPolling(): void {
  const running = useDatabaseCompactionRunState().status?.state === "running";
  const connection = useWsConnectionStatus();
  const connectionKey =
    connection.phase === "connected"
      ? `${connection.socketUrl ?? ""}|${connection.connectedAt ?? ""}`
      : null;

  useEffect(() => {
    let cancelled = false;
    readStatusWhileIdle().catch(() => {
      if (!cancelled && state.status === null) setRunState({ ...state, statusUnavailable: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A new connection may be to a restarted backend, or follow a run started meanwhile.
  useEffect(() => {
    if (connectionKey === null) return;
    readStatusWhileIdle().catch(() => undefined);
  }, [connectionKey]);

  useEffect(() => {
    if (running) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (pageVisible()) readStatusWhileIdle().catch(() => undefined);
      timer = setTimeout(tick, idlePollMs);
    };
    const onVisibility = () => {
      if (pageVisible()) readStatusWhileIdle().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    timer = setTimeout(tick, idlePollMs);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
    };
  }, [running]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await ensureNativeApi().server.getDatabaseCompactionStatus({});
        if (cancelled) return;
        applyStatus(next);
        if (next.state === "idle") return;
        timer = setTimeout(poll, POLL_MS);
      } catch {
        if (cancelled) return;
        setRunState({ ...state, reconnecting: true });
        timer = setTimeout(poll, RECONNECT_POLL_MS);
      }
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [running]);
}

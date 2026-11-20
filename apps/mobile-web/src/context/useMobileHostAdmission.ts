import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";

import { bindMobileSessionAuthority } from "../lib/mobileSessionAuthority";
import { migrateMobileSessionDrafts } from "../lib/mobileComposerDraft.migration";
import type { StoredMobileSession } from "../lib/mobileSession";

import {
  admittedMobileHostSession,
  MobileHostAdmissionRejectedError,
  verifyMobileHostConnection,
  type MobileHostEntry,
} from "../lib/mobileHostConnection";

function sameHost(previous: MobileHostEntry | null, next: MobileHostEntry | null) {
  if (!previous || !next) return previous === next;
  return (
    previous.backendOrigin === next.backendOrigin &&
    previous.pin.authority.authorityId === next.pin.authority.authorityId &&
    previous.pin.authority.keyFingerprint === next.pin.authority.keyFingerprint &&
    previous.pin.authority.keyEpoch === next.pin.authority.keyEpoch &&
    previous.pin.installationFingerprint === next.pin.installationFingerprint &&
    previous.session.sessionId === next.session.sessionId &&
    previous.session.sessionToken === next.session.sessionToken &&
    previous.session.scope === next.session.scope &&
    previous.session.expiresAt === next.session.expiresAt
  );
}
interface Admission {
  readonly host: MobileHostEntry | null;
  readonly generation: number;
  readonly status: "idle" | "checking" | "ready" | "blocked" | "failed";
  readonly error: string | null;
  readonly descriptor: RemoteBackendMobileDescriptor | null;
  readonly session: StoredMobileSession | null;
}

/** No active session is exposed until this exact stored pin passes its real HTTPS descriptor. */
export function useMobileHostAdmission(host: MobileHostEntry | null) {
  const [state, setState] = useState<Admission>(() => ({
    host,
    generation: 1,
    status: host ? "checking" : "idle",
    error: null,
    descriptor: null,
    session: null,
  }));
  if (!sameHost(state.host, host)) {
    setState({
      host,
      generation: state.generation + 1,
      status: host ? "checking" : "idle",
      error: null,
      descriptor: null,
      session: null,
    });
  }
  const { generation } = state;
  const committed = useRef<number | null>(null);
  useLayoutEffect(() => {
    committed.current = generation;
    return () => {
      if (committed.current === generation) committed.current = null;
    };
  }, [generation]);

  useEffect(() => {
    const selected = state.host;
    if (!selected) return;
    const abort = new AbortController();
    let active = true;
    void verifyMobileHostConnection(selected, { signal: abort.signal })
      .then((descriptor) => {
        if (!active || committed.current !== generation) return;
        const runtimeSession = bindMobileSessionAuthority(
          admittedMobileHostSession(selected),
          descriptor.authority.authorityId,
        );
        const migration = migrateMobileSessionDrafts(runtimeSession);
        if (!migration.ok)
          throw new Error(
            "Saved drafts could not be safely migrated. The previous connection and drafts are preserved; retry or use the previous connection.",
          );
        setState((current) =>
          current.generation === generation
            ? { ...current, status: "ready", descriptor, session: runtimeSession, error: null }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (!active || committed.current !== generation) return;
        setState((current) =>
          current.generation === generation
            ? {
                ...current,
                status: error instanceof MobileHostAdmissionRejectedError ? "blocked" : "failed",
                error:
                  error instanceof Error
                    ? error.message
                    : "Could not verify this host. Retry before connecting.",
              }
            : current,
        );
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [generation, state.host]);

  const beforeConnect = useCallback(
    async (signal: AbortSignal) => {
      const selected = state.host;
      if (!selected || committed.current !== generation)
        throw new DOMException("Retired mobile host", "AbortError");
      try {
        await verifyMobileHostConnection(selected, { signal });
        signal.throwIfAborted();
        if (committed.current !== generation)
          throw new DOMException("Retired mobile host", "AbortError");
      } catch (error) {
        if (error instanceof MobileHostAdmissionRejectedError && committed.current === generation) {
          setState((current) =>
            current.generation === generation
              ? { ...current, status: "blocked", error: error.message }
              : current,
          );
        }
        throw error;
      }
    },
    [generation, state.host],
  );

  const session = state.status === "ready" ? state.session : null;
  const retry = useCallback(
    () =>
      setState((current) => ({
        ...current,
        generation: current.generation + 1,
        status: current.host ? "checking" : "idle",
        error: null,
        descriptor: null,
        session: null,
      })),
    [],
  );
  return useMemo(
    () => ({
      ...state,
      session: sameHost(state.host, host) ? session : null,
      beforeConnect,
      retry,
    }),
    [state, host, session, beforeConnect, retry],
  );
}

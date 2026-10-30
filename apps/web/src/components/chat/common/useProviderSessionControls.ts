import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type {
  ProviderControlsInput,
  ProviderControlsSnapshot,
} from "@bigbud/contracts/server/providerControls";
import { readNativeApi } from "~/rpc/nativeApi";
import { controlsMatch } from "./ProviderSessionControls.logic";

/** Single-flight requests; changing thread/epoch invalidates every in-flight response. */
export function useProviderSessionControls(
  threadId: ThreadId,
  sessionEpoch: number | undefined,
  open: boolean,
) {
  const identity = `${threadId}:${sessionEpoch}`;
  const current = useRef({ identity });
  if (current.current.identity !== identity) current.current = { identity };
  const owner = current.current;
  const flight = useRef<object | null>(null);
  const [observation, setObservation] = useState<{
    owner: object;
    value: ProviderControlsSnapshot;
  } | null>(null);
  const setSnapshot = useCallback(
    (update: SetStateAction<ProviderControlsSnapshot | null>) => {
      setObservation((previous) => {
        if (current.current !== owner) return previous;
        const value = previous?.owner === owner ? previous.value : null;
        const next = typeof update === "function" ? update(value) : update;
        return next ? { owner, value: next } : null;
      });
    },
    [owner],
  );
  const snapshot = observation?.owner === owner ? observation.value : null;
  const [pending, setPending] = useState<object | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useCallback(
    async (action: ProviderControlsInput["action"]) => {
      if (current.current !== owner || flight.current === owner || sessionEpoch === undefined)
        return;
      flight.current = owner;
      setPending(owner);
      try {
        const controls = readNativeApi()?.server.providerControls;
        if (!controls)
          throw new Error("Native session controls are unavailable on this transport.");
        const result = await controls({ threadId, sessionEpoch, action });
        if (current.current !== owner || !controlsMatch(result, threadId, sessionEpoch)) return;
        setSnapshot((previous) => ({
          ...result,
          ...(result.servers === undefined &&
          controlsMatch(previous, threadId, sessionEpoch) &&
          previous?.servers
            ? { servers: previous.servers }
            : {}),
          ...((action === "status" || action === "refresh-mcp") &&
          controlsMatch(previous, threadId, sessionEpoch)
            ? {
                ...(previous?.reloadState ? { reloadState: previous.reloadState } : {}),
                ...(previous?.message && !result.message ? { message: previous.message } : {}),
              }
            : {}),
        }));
        if (action !== "status") setError(null);
      } catch (cause) {
        if (current.current !== owner) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Maintenance failed or its outcome is unknown. Refresh status; do not retry automatically.",
        );
        if (action === "compact" || action === "reload-mcp")
          setSnapshot((previous) =>
            previous && controlsMatch(previous, threadId, sessionEpoch)
              ? {
                  ...previous,
                  compact: {
                    available: false,
                    reason: "Maintenance outcome is unknown. Refresh status before further action.",
                  },
                  mcpReload: {
                    available: false,
                    reason: "Maintenance outcome is unknown. Refresh status before further action.",
                  },
                  ...(action === "compact"
                    ? { compactState: "unknown" as const }
                    : { reloadState: "unknown" as const }),
                }
              : previous,
          );
      } finally {
        if (flight.current === owner) flight.current = null;
        if (current.current === owner) setPending(null);
      }
    },
    [owner, threadId, sessionEpoch, setSnapshot],
  );
  useEffect(() => {
    setError(null);
    current.current = owner;
    return () => {
      if (current.current === owner) current.current = { identity: "" };
    };
  }, [owner]);
  useEffect(() => {
    if (open) void request("status");
  }, [identity, open, request]);
  const visible = controlsMatch(snapshot, threadId, sessionEpoch) ? snapshot : null;
  const state = visible?.compactState;
  const waitStarted = useRef<{ owner: object; at: number } | null>(null);
  useEffect(() => {
    if (!open || (state !== "submitted" && state !== "working")) return;
    if (waitStarted.current?.owner !== owner) waitStarted.current = { owner, at: Date.now() };
    // Reads only, never replay the submitted mutation. The server's own deadline yields unknown.
    const timer = setInterval(() => {
      if (Date.now() - waitStarted.current!.at >= 65_000) {
        setSnapshot((previous) =>
          previous && controlsMatch(previous, threadId, sessionEpoch)
            ? {
                ...previous,
                compactState: "unknown",
                compact: {
                  available: false,
                  reason:
                    "Native completion was not confirmed. Refresh status; do not automatically retry.",
                },
              }
            : previous,
        );
        return;
      }
      void request("status");
    }, 2_000);
    return () => clearInterval(timer);
  }, [open, state, owner, threadId, sessionEpoch, request, setSnapshot]);
  useEffect(() => {
    if (state !== "submitted" && state !== "working") waitStarted.current = null;
  }, [state]);
  return { snapshot: visible, pending: pending === owner, error, request };
}

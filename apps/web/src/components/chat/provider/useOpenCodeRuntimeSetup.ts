import { useEffect, useRef, useState } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import type { UnifiedSettings } from "@bigbud/contracts/settings";
import type { ServerOpencodeV2ThreadToolsSetupResult } from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { hasOpencodeV2ManagedPluginTrust } from "@bigbud/shared/opencodeNativeTrust";
import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { ensureNativeApi } from "~/rpc/nativeApi";
import { useWsConnectionStatus } from "~/rpc/wsConnectionState";
import { isPendingOpenCodeSetup, observeOpenCodeSetup } from "./opencodeSetup.observer";

/** Ephemeral, chat-scoped readiness; actual turn admission always performs its own checks. */
export function useOpenCodeRuntimeSetup(input: {
  status: ServerProvider | null;
  settings: UnifiedSettings["providers"]["opencodeV2"];
  directory: string | undefined;
  threadId: ThreadId | undefined;
  threadError: string | null | undefined;
}) {
  const connection = useWsConnectionStatus();
  const [attempt, setAttempt] = useState(0);
  const stopObservation = useRef<(() => void) | undefined>(undefined);
  const operation = useRef(0);
  const cancelling = useRef(false);
  const { status, settings, directory, threadId, threadError } = input;
  const enabled = Boolean(
    status?.provider === "opencodeV2" &&
    status.enabled &&
    status.installed &&
    status.initialProbeComplete !== false &&
    ["ready", "warning"].includes(status.status) &&
    !status.failure &&
    status.auth.status !== "unauthenticated" &&
    status.recovery?.status !== "retrying" &&
    settings.enabled &&
    hasOpencodeV2ManagedPluginTrust(settings) &&
    resolveOpencodeV2ConnectionMode(settings) === "shared" &&
    connection.phase === "connected" &&
    directory,
  );
  const scope = JSON.stringify([
    attempt,
    enabled,
    settings,
    directory,
    threadId,
    threadError,
    status?.version,
    connection.connectedAt,
    connection.socketUrl,
  ]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const [state, setState] = useState<{
    scope: string;
    result?: ServerOpencodeV2ThreadToolsSetupResult;
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    latestScope.current = scope;
    const generation = ++operation.current;
    cancelling.current = false;
    stopObservation.current?.();
    if (!enabled || !directory) return;
    setState({ scope });
    const stop = observeOpenCodeSetup(
      (request) => ensureNativeApi().server.getOpencodeV2ThreadToolsSetup(request),
      { directory, ...(threadId ? { threadId } : {}), refresh: true },
      (result) => {
        if (latestScope.current === scope && operation.current === generation)
          setState({ scope, result });
      },
      () => {
        if (latestScope.current === scope && operation.current === generation)
          setState((previous) => ({ ...previous, scope, failed: true }));
      },
    );
    stopObservation.current = stop;
    return () => {
      latestScope.current = "";
      cancelling.current = false;
      stopObservation.current?.();
      stopObservation.current = undefined;
    };
  }, [scope, enabled, directory, threadId]);
  const current = enabled && state?.scope === scope ? state : null;
  const result = current?.result;
  async function cancel() {
    if (!result?.jobId || !result.interestId || cancelling.current || latestScope.current !== scope)
      return;
    cancelling.current = true;
    const generation = ++operation.current;
    const isCurrent = () => latestScope.current === scope && operation.current === generation;
    stopObservation.current?.();
    try {
      const reply = await ensureNativeApi().server.getOpencodeV2ThreadToolsSetup({
        operation: "cancel-interest",
        jobId: result.jobId,
        interestId: result.interestId,
      });
      if (isCurrent()) {
        setState({ scope, result: reply });
        if (isPendingOpenCodeSetup(reply)) {
          stopObservation.current?.();
          stopObservation.current = observeOpenCodeSetup(
            (request) => ensureNativeApi().server.getOpencodeV2ThreadToolsSetup(request),
            { operation: "status", jobId: reply.jobId! },
            (value) => {
              if (isCurrent()) setState({ scope, result: value });
            },
            () => {
              if (isCurrent()) setState((previous) => ({ ...previous, scope, failed: true }));
            },
          );
        }
      }
    } catch {
      if (isCurrent()) setState((previous) => ({ ...previous, scope, failed: true }));
    } finally {
      if (isCurrent()) cancelling.current = false;
    }
  }
  return {
    result,
    retry: () => setAttempt((value) => value + 1),
    cancel,
    noticeIdentity: result
      ? [
          result.reasonCode,
          result.activationState,
          result.artifactDigest,
          result.issuerKeyId,
          result.installedBootstrapDigest,
          result.desiredBootstrapDigest,
          result.activeImplementationDigest,
          result.qualificationRecordId,
        ]
      : null,
    verified:
      result?.status === "ready" &&
      result.activationState === "ready" &&
      result.directory === directory &&
      Boolean(result.artifactDigest) &&
      result.nativeVersion === status?.version &&
      (result.qualificationState === "qualified" || result.qualificationState === "unqualified"),
    error: current?.failed
      ? "Setup status observation stopped or timed out. The job may still be running; no prompt was replayed. Retry setup to check again."
      : result &&
          result.status !== "ready" &&
          ["blocked", "failed", "uncertain", "cancelled", "deferred"].includes(
            result.activationState ?? "blocked",
          )
        ? result.message
        : null,
    severity:
      current?.failed || result?.severity === "error" ? ("error" as const) : ("warning" as const),
  };
}

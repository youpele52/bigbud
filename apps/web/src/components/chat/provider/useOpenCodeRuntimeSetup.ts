import { useEffect, useState } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import type { UnifiedSettings } from "@bigbud/contracts/settings";
import type { ServerOpencodeV2ThreadToolsSetupResult } from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { hasOpencodeV2ManagedPluginTrust } from "@bigbud/shared/opencodeNativeTrust";
import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { ensureNativeApi } from "~/rpc/nativeApi";
import { useWsConnectionStatus } from "~/rpc/wsConnectionState";
import { observeOpenCodeSetup } from "./opencodeSetup.observer";

/** Ephemeral, chat-scoped readiness; actual turn admission always performs its own checks. */
export function useOpenCodeRuntimeSetup(input: {
  status: ServerProvider | null;
  settings: UnifiedSettings["providers"]["opencodeV2"];
  directory: string | undefined;
  threadId: ThreadId | undefined;
  threadError: string | null | undefined;
}) {
  const connection = useWsConnectionStatus();
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
    enabled,
    settings,
    directory,
    threadId,
    threadError,
    status?.version,
    connection.connectedAt,
    connection.socketUrl,
  ]);
  const [state, setState] = useState<{
    scope: string;
    result?: ServerOpencodeV2ThreadToolsSetupResult;
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !directory) return;
    setState({ scope });
    return observeOpenCodeSetup(
      (request) => ensureNativeApi().server.getOpencodeV2ThreadToolsSetup(request),
      { directory, ...(threadId ? { threadId } : {}), refresh: true },
      (result) => setState({ scope, result }),
      () => setState({ scope, failed: true }),
    );
  }, [scope, enabled, directory, threadId]);
  const current = enabled && state?.scope === scope ? state : null;
  const result = current?.result;
  return {
    verified:
      result?.status === "ready" &&
      result.activationState === "ready" &&
      result.directory === directory &&
      Boolean(result.artifactDigest) &&
      result.nativeVersion === status?.version &&
      (result.qualificationState === "qualified" || result.qualificationState === "unqualified"),
    error: current?.failed
      ? "Automatic OpenCode bridge verification did not finish. Retry setup in Providers settings."
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

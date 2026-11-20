import { useCallback, useState } from "react";

import type { ServerInstallRemoteAgentResult } from "@bigbud/contracts/server/server.ts";

import { readNativeApi } from "../../rpc/nativeApi";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import { installAndConnectRemoteAgent } from "../sidebar/Sidebar.remoteWorkspaceAgentInstall";
import { reconfigureRemoteWorkspace } from "../sidebar/Sidebar.remoteWorkspaceAddActions.edit";
import {
  createRemoteWorkspaceDraft,
  createRemoteWorkspaceExecutionTargetId,
} from "../sidebar/Sidebar.remoteWorkspaces.logic";
import type { RemoteAgentHost } from "./RemoteAgentManagementSection.logic";

export type RemoteAgentNoticeTone = "info" | "success" | "warning" | "error";

export interface RemoteAgentHostNotice {
  readonly hostLabel: string;
  readonly tone: RemoteAgentNoticeTone;
  readonly message: string;
  readonly details?: ReadonlyArray<string>;
}

export const REMOVED_NOTICE = "Removed. Reconnect over SSH or the remote agent.";

function requireApi() {
  const api = readNativeApi();
  if (!api) throw new Error("Native API not found.");
  return api;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/** The host's agent target: itself for agent workspaces, else the same host over the agent. */
export function agentTargetForHost(host: RemoteAgentHost): string | null {
  if (host.transport === "agent") return host.target;
  const draft = host.projects[0] ? createRemoteWorkspaceDraft(host.projects[0]) : null;
  return draft
    ? createRemoteWorkspaceExecutionTargetId({ ...draft, remoteTransport: "agent" })
    : null;
}

function installTone(result: ServerInstallRemoteAgentResult): RemoteAgentNoticeTone {
  if (result.outcome === "failed") return "error";
  if (result.outcome === "deferred" || result.outcome === "uncertain" || result.cleanupDeferred)
    return "warning";
  return "success";
}

/** Settings → Remote agents actions. Each action runs only on explicit request, one at a time. */
export function useRemoteAgentHostActions() {
  const [busy, setBusy] = useState<{ readonly target: string; readonly action: string } | null>(
    null,
  );
  const [notices, setNotices] = useState<Record<string, RemoteAgentHostNotice>>({});
  const [removed, setRemoved] = useState<Record<string, true>>({});
  const [installed, setInstalled] = useState<Record<string, true>>({});
  const notify = useCallback(
    (target: string, notice: RemoteAgentHostNotice) =>
      setNotices((current) => ({ ...current, [target]: notice })),
    [],
  );

  const run = useCallback(
    async (host: RemoteAgentHost, action: string, task: () => Promise<RemoteAgentHostNotice>) => {
      if (busy) return;
      setBusy({ target: host.target, action });
      try {
        notify(host.target, await task());
      } catch (cause) {
        notify(host.target, {
          hostLabel: host.hostLabel,
          tone: "error",
          message: errorMessage(cause, "The request did not complete."),
        });
      } finally {
        setBusy(null);
      }
    },
    [busy, notify],
  );

  const stageOrReplace = (host: RemoteAgentHost, replace: boolean) =>
    run(host, replace ? "replace" : "update", async () => {
      const result = await requireApi().server.installRemoteAgent({
        executionTargetId: host.target,
        ...(replace ? { replace: true } : {}),
      });
      return { hostLabel: host.hostLabel, tone: installTone(result), message: result.message };
    });

  const install = (host: RemoteAgentHost) =>
    run(host, "install", async () => {
      const agentTarget = agentTargetForHost(host);
      if (!agentTarget) throw new Error("This host has no saved SSH connection details.");
      const result = await installAndConnectRemoteAgent({
        api: requireApi(),
        executionTargetId: agentTarget,
        onProgress: (progress) =>
          notify(host.target, {
            hostLabel: host.hostLabel,
            tone: "info",
            message: progress === "downloading" ? "Downloading verified agent…" : "Connecting…",
          }),
      });
      setRemoved(({ [host.target]: _removed, ...rest }) => rest);
      if (host.transport === "direct-ssh")
        setInstalled((current) => ({ ...current, [host.target]: true }));
      return {
        hostLabel: host.hostLabel,
        tone: result.warning ? "warning" : "success",
        message: [result.message, result.cleanupMessage].filter(Boolean).join(" "),
      };
    });

  const remove = (host: RemoteAgentHost, switchWorkspacesToDirectSsh: boolean) =>
    run(host, "remove", async () => {
      const agentTarget = agentTargetForHost(host);
      if (!agentTarget) throw new Error("This host has no saved SSH connection details.");
      const result = await requireApi().server.removeRemoteAgent({
        executionTargetId: agentTarget,
        switchWorkspacesToDirectSsh,
      });
      if (result.outcome === "blocked")
        return {
          hostLabel: host.hostLabel,
          tone: "warning",
          message: "Nothing was removed. Live work still uses the agent:",
          details: result.blockers.map((blocker) => blocker.label),
        };
      if (result.outcome === "failed")
        return { hostLabel: host.hostLabel, tone: "error", message: result.message };
      const store = useRemoteAccessStore.getState();
      store.markExecutionTargetDisconnected(agentTarget);
      store.clearExecutionTargetVerified(agentTarget);
      setRemoved((current) => ({ ...current, [host.target]: true }));
      setInstalled(({ [host.target]: _installed, ...rest }) => rest);
      const kept = switchWorkspacesToDirectSsh
        ? host.projects.filter((project) => !result.switchedWorkspaceIds.includes(project.id))
        : [];
      return kept.length > 0 && host.transport === "agent"
        ? {
            hostLabel: host.hostLabel,
            tone: "warning",
            message: `${REMOVED_NOTICE} These workspaces still use the remote agent:`,
            details: kept.map((project) => project.name),
          }
        : { hostLabel: host.hostLabel, tone: "success", message: REMOVED_NOTICE };
    });

  const switchToAgent = (host: RemoteAgentHost) =>
    run(host, "switch", async () => {
      const failures: string[] = [];
      for (const project of host.projects) {
        const draft = createRemoteWorkspaceDraft(project);
        const error =
          draft && project.updatedAt
            ? await reconfigureRemoteWorkspace({
                projectId: project.id,
                title: project.name,
                draft: { ...draft, remoteTransport: "agent" },
                expectedUpdatedAt: project.updatedAt,
              })
            : "Workspace details are unavailable.";
        if (error) failures.push(`${project.name}: ${error}`);
      }
      return failures.length === 0
        ? {
            hostLabel: host.hostLabel,
            tone: "success",
            message: "Workspaces now use the remote agent.",
          }
        : {
            hostLabel: host.hostLabel,
            tone: "warning",
            message: "Some workspaces still use Direct SSH:",
            details: failures,
          };
    });

  return {
    busy,
    notices,
    removed,
    installed,
    update: (host: RemoteAgentHost) => stageOrReplace(host, false),
    replaceNow: (host: RemoteAgentHost) => stageOrReplace(host, true),
    install,
    remove,
    switchToAgent,
    notify,
  };
}

import { useEffect, useRef } from "react";

import {
  hasRemoteWorkspaceConnectionOverrides,
  type RemoteWorkspaceConnectionSource,
  type RemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";
import type { SshConfigHostsState } from "./SidebarRemoteWorkspaceDialog.sshConfigHosts";

interface SourceInferenceInput {
  readonly open: boolean;
  readonly mode: "add" | "edit";
  readonly draft: RemoteWorkspaceDraft;
  readonly hosts: SshConfigHostsState;
  /** Verifying, submitting, or showing a result: the user has acted, so leave the mode alone. */
  readonly busy: boolean;
  readonly onAdopt: (source: RemoteWorkspaceConnectionSource) => void;
}

/**
 * Edit mode only: once SSH config hosts first load, show an untouched pure-alias project in
 * "From SSH config". Decides at most once per open and never after the user has acted.
 */
export function useRemoteWorkspaceSourceInference({
  open,
  mode,
  draft,
  hosts,
  busy,
  onAdopt,
}: SourceInferenceInput): void {
  const stateRef = useRef<{ decided: boolean; initialDraft: RemoteWorkspaceDraft | null }>({
    decided: false,
    initialDraft: null,
  });

  useEffect(() => {
    const state = stateRef.current;
    if (!open || mode !== "edit") {
      state.decided = false;
      state.initialDraft = null;
      return;
    }
    if (state.decided) return;
    state.initialDraft ??= draft;
    if (hosts.status === "idle" || hosts.status === "loading") return;

    state.decided = true;
    if (
      hosts.status !== "ready" ||
      busy ||
      draft !== state.initialDraft ||
      draft.connectionSource !== "manual" ||
      hasRemoteWorkspaceConnectionOverrides(draft) ||
      !hosts.result.hosts.some((host) => host.alias === draft.host.trim())
    ) {
      return;
    }
    onAdopt("ssh-config");
  }, [busy, draft, hosts, mode, onAdopt, open]);
}

import { useEffect, useRef } from "react";

import {
  hasRemoteProjectConnectionOverrides,
  type RemoteProjectConnectionSource,
  type RemoteProjectDraft,
} from "./Sidebar.projects.logic";
import type { SshConfigHostsState } from "./SidebarRemoteProjectDialog.sshConfigHosts";

interface SourceInferenceInput {
  readonly open: boolean;
  readonly mode: "add" | "edit";
  readonly draft: RemoteProjectDraft;
  readonly hosts: SshConfigHostsState;
  /** Verifying, submitting, or showing a result: the user has acted, so leave the mode alone. */
  readonly busy: boolean;
  readonly onAdopt: (source: RemoteProjectConnectionSource) => void;
}

/**
 * Edit mode only: once SSH config hosts first load, show an untouched pure-alias project in
 * "From SSH config". Decides at most once per open and never after the user has acted.
 */
export function useRemoteProjectSourceInference({
  open,
  mode,
  draft,
  hosts,
  busy,
  onAdopt,
}: SourceInferenceInput): void {
  const stateRef = useRef<{ decided: boolean; initialDraft: RemoteProjectDraft | null }>({
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
      hasRemoteProjectConnectionOverrides(draft) ||
      !hosts.result.hosts.some((host) => host.alias === draft.host.trim())
    ) {
      return;
    }
    onAdopt("ssh-config");
  }, [busy, draft, hosts, mode, onAdopt, open]);
}

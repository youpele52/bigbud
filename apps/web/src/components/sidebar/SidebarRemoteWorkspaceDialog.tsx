import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import type {
  RemoteWorkspaceConnectionSource,
  RemoteWorkspaceDraft,
  RequestRemoteWorkspaceUnlock,
  UpdateRemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";
import { rememberRemoteWorkspaceConnectionSource } from "./Sidebar.remoteWorkspaces.connectionSourcePreference";
import { remoteWorkspaceAgentTarget, SidebarRemoteAgentStatus } from "./SidebarRemoteAgentStatus";
import { SidebarRemoteWorkspaceManualFields } from "./SidebarRemoteWorkspaceDialog.manualFields";
import { SidebarRemoteWorkspacePathField } from "./SidebarRemoteWorkspaceDialog.pathField";
import {
  RemoteWorkspaceAuthenticationFields,
  RemoteWorkspaceConnectionOptions,
  remoteWorkspaceInputClassName,
  type RemoteWorkspaceFieldErrors,
} from "./SidebarRemoteWorkspaceDialog.options";
import {
  SidebarRemoteWorkspaceSshConfigAdvanced,
  SidebarRemoteWorkspaceSshConfigHostField,
} from "./SidebarRemoteWorkspaceDialog.sshConfigFields";
import { useSshConfigHosts } from "./SidebarRemoteWorkspaceDialog.sshConfigHosts";
import { useRemoteWorkspaceSourceInference } from "./SidebarRemoteWorkspaceDialog.sourceInference";

interface SidebarRemoteWorkspaceDialogProps {
  mode: "add" | "edit";
  open: boolean;
  draft: RemoteWorkspaceDraft;
  fieldErrors: RemoteWorkspaceFieldErrors;
  error: string | null;
  verificationMessage: string | null;
  isSubmitting: boolean;
  isVerifying: boolean;
  onOpenChange: (open: boolean) => void;
  onFieldChange: UpdateRemoteWorkspaceDraft;
  /** Switches the source without invalidating verification; edit-mode inference only. */
  onAdoptConnectionSource: (source: RemoteWorkspaceConnectionSource) => void;
  onRequestUnlock: RequestRemoteWorkspaceUnlock;
  onSubmit: () => void;
}

export function SidebarRemoteWorkspaceDialog({
  mode,
  open,
  draft,
  fieldErrors,
  error,
  verificationMessage,
  isSubmitting,
  isVerifying,
  onOpenChange,
  onFieldChange,
  onAdoptConnectionSource,
  onRequestUnlock,
  onSubmit,
}: SidebarRemoteWorkspaceDialogProps) {
  const isEditing = mode === "edit";
  const isSshConfig = draft.connectionSource === "ssh-config";
  const agentTarget = isEditing ? remoteWorkspaceAgentTarget(draft) : null;
  const hosts = useSshConfigHosts(open && (isSshConfig || isEditing));
  useRemoteWorkspaceSourceInference({
    open,
    mode,
    draft,
    hosts,
    busy: isVerifying || isSubmitting || error !== null || verificationMessage !== null,
    onAdopt: onAdoptConnectionSource,
  });

  const changeSource = (source: RemoteWorkspaceConnectionSource) => {
    if (!isEditing) rememberRemoteWorkspaceConnectionSource(source);
    onFieldChange("connectionSource", source);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit remote workspace" : "Add remote workspace"}</DialogTitle>
          <DialogDescription>
            Open a workspace on another machine over SSH. bigbud checks the connection before{" "}
            {isEditing ? "saving your changes" : "adding it"}.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <ToggleGroup
            aria-label="Connection source"
            className="w-full"
            variant="outline"
            value={[draft.connectionSource]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "manual" || next === "ssh-config") changeSource(next);
            }}
          >
            <ToggleGroupItem className="flex-1 text-sm" value="ssh-config">
              From SSH config
            </ToggleGroupItem>
            <ToggleGroupItem className="flex-1 text-sm" value="manual">
              Enter manually
            </ToggleGroupItem>
          </ToggleGroup>

          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="remote-workspace-display-name" className="block sm:col-span-2">
              <span className="text-xs font-medium text-foreground">Display name</span>
              <Input
                id="remote-workspace-display-name"
                className={remoteWorkspaceInputClassName}
                placeholder="Optional sidebar label"
                spellCheck={false}
                value={draft.displayName}
                onChange={(event) => onFieldChange("displayName", event.target.value)}
              />
            </label>

            {isSshConfig ? (
              <div className="sm:col-span-2">
                <SidebarRemoteWorkspaceSshConfigHostField
                  draft={draft}
                  fieldErrors={fieldErrors}
                  hosts={hosts}
                  onFieldChange={onFieldChange}
                  onUseManual={() => changeSource("manual")}
                />
              </div>
            ) : (
              <SidebarRemoteWorkspaceManualFields
                draft={draft}
                fieldErrors={fieldErrors}
                onFieldChange={onFieldChange}
              />
            )}

            <div className="sm:col-span-2">
              <SidebarRemoteWorkspacePathField
                draft={draft}
                fieldErrors={fieldErrors}
                onFieldChange={onFieldChange}
                onRequestUnlock={onRequestUnlock}
              />
            </div>
          </div>

          <RemoteWorkspaceConnectionOptions draft={draft} onFieldChange={onFieldChange} />

          {isSshConfig ? (
            <SidebarRemoteWorkspaceSshConfigAdvanced
              draft={draft}
              fieldErrors={fieldErrors}
              onFieldChange={onFieldChange}
            />
          ) : (
            <RemoteWorkspaceAuthenticationFields draft={draft} onFieldChange={onFieldChange} />
          )}

          {verificationMessage ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-emerald-700 text-xs leading-4 dark:text-emerald-300">
              {verificationMessage}
            </div>
          ) : null}
          {agentTarget && open ? (
            <SidebarRemoteAgentStatus executionTargetId={agentTarget} cwd={draft.workspaceRoot} />
          ) : isEditing && draft.remoteTransport === "direct-ssh" ? (
            <section
              aria-label="Remote connection"
              className="rounded-lg border border-border p-3 text-sm"
            >
              <dl className="grid grid-cols-2 gap-1">
                <dt>Current connection</dt>
                <dd>Direct SSH</dd>
              </dl>
            </section>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive text-xs leading-4">
              {error}
            </div>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={isSubmitting || isVerifying} onClick={onSubmit}>
            {isSubmitting
              ? isEditing
                ? "Saving..."
                : "Adding..."
              : isVerifying
                ? "Verifying..."
                : isEditing
                  ? "Save changes"
                  : "Add remote workspace"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

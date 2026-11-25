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
import { createRemoteWorkspaceExecutionTargetId } from "./Sidebar.remoteWorkspaces.logic";
import { Alert, AlertDescription } from "../ui/alert";
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
import type { RemoteAgentInstallProgress } from "./Sidebar.remoteWorkspaceAgentInstall";
import { SidebarRemoteAgentManualInstall } from "./SidebarRemoteAgentManualInstall";
import {
  devSshOwnerTargetId,
  RemoteWorkspaceDevOwnerControls,
} from "./SidebarRemoteWorkspaceDialog.owner";

interface SidebarRemoteWorkspaceDialogProps {
  mode: "add" | "edit";
  open: boolean;
  draft: RemoteWorkspaceDraft;
  fieldErrors: RemoteWorkspaceFieldErrors;
  error: string | null;
  verificationMessage: string | null;
  /** Save's inline agent install progress. */
  agentInstallProgress?: RemoteAgentInstallProgress | null;
  /** After a failed inline install, the target whose manual command opens expanded. */
  manualInstallTarget?: string | null;
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
  agentInstallProgress = null,
  manualInstallTarget = null,
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
  const devOwner = devSshOwnerTargetId(hosts);
  const devOwnerBrowseOnly =
    hosts.status === "ready" && hosts.result.developmentOwnerBrowseOnly === true;
  const devOwnerPrePinnedJump =
    hosts.status === "ready" && hosts.result.developmentOwnerPrePinnedJump === true;
  const devOwnerTerminalUnsupported =
    hosts.status === "ready" && hosts.result.developmentOwnerTerminalUnsupported === true;
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

          {devOwner ? <RemoteWorkspaceDevOwnerControls draft={draft} targetId={devOwner} /> : null}
          {devOwnerTerminalUnsupported ? (
            <p className="text-xs text-muted-foreground">
              {devOwnerBrowseOnly
                ? "This development target supports folder browsing only."
                : "This development target supports browsing and file previews, not terminals."}
            </p>
          ) : null}
          {devOwnerPrePinnedJump ? (
            <p className="text-xs text-muted-foreground">
              This jump route uses pre-approved fixture keys. First-use host key approval is
              unavailable.
            </p>
          ) : null}
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

          {agentInstallProgress ? (
            <Alert variant="loading" role="status" className="text-xs leading-4">
              <AlertDescription>
                {agentInstallProgress === "downloading"
                  ? "Downloading verified agent…"
                  : "Connecting…"}
              </AlertDescription>
            </Alert>
          ) : null}
          {verificationMessage ? (
            <Alert variant="success" role="status" className="text-xs leading-4">
              <AlertDescription>{verificationMessage}</AlertDescription>
            </Alert>
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
            <Alert variant="error" className="text-xs leading-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {error && manualInstallTarget ? (
            <SidebarRemoteAgentManualInstall
              executionTargetId={manualInstallTarget}
              autoOpen
              onOpenChange={() => {}}
            />
          ) : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              isSubmitting ||
              isVerifying ||
              devOwnerBrowseOnly ||
              (devOwner !== undefined && createRemoteWorkspaceExecutionTargetId(draft) !== devOwner)
            }
            onClick={onSubmit}
          >
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

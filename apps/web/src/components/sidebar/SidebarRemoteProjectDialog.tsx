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
  RemoteProjectConnectionSource,
  RemoteProjectDraft,
  RequestRemoteProjectUnlock,
  UpdateRemoteProjectDraft,
} from "./Sidebar.projects.logic";
import { rememberRemoteProjectConnectionSource } from "./Sidebar.projects.connectionSourcePreference";
import { remoteProjectAgentTarget, SidebarRemoteAgentStatus } from "./SidebarRemoteAgentStatus";
import { SidebarRemoteProjectManualFields } from "./SidebarRemoteProjectDialog.manualFields";
import { SidebarRemoteProjectPathField } from "./SidebarRemoteProjectDialog.pathField";
import {
  RemoteProjectAuthenticationFields,
  RemoteProjectConnectionOptions,
  remoteProjectInputClassName,
  type RemoteProjectFieldErrors,
} from "./SidebarRemoteProjectDialog.options";
import {
  SidebarRemoteProjectSshConfigAdvanced,
  SidebarRemoteProjectSshConfigHostField,
} from "./SidebarRemoteProjectDialog.sshConfigFields";
import { useSshConfigHosts } from "./SidebarRemoteProjectDialog.sshConfigHosts";
import { useRemoteProjectSourceInference } from "./SidebarRemoteProjectDialog.sourceInference";

interface SidebarRemoteProjectDialogProps {
  mode: "add" | "edit";
  open: boolean;
  draft: RemoteProjectDraft;
  fieldErrors: RemoteProjectFieldErrors;
  error: string | null;
  verificationMessage: string | null;
  isSubmitting: boolean;
  isVerifying: boolean;
  onOpenChange: (open: boolean) => void;
  onFieldChange: UpdateRemoteProjectDraft;
  /** Switches the source without invalidating verification; edit-mode inference only. */
  onAdoptConnectionSource: (source: RemoteProjectConnectionSource) => void;
  onRequestUnlock: RequestRemoteProjectUnlock;
  onSubmit: () => void;
}

export function SidebarRemoteProjectDialog({
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
}: SidebarRemoteProjectDialogProps) {
  const isEditing = mode === "edit";
  const isSshConfig = draft.connectionSource === "ssh-config";
  const agentTarget = isEditing ? remoteProjectAgentTarget(draft) : null;
  const hosts = useSshConfigHosts(open && (isSshConfig || isEditing));
  useRemoteProjectSourceInference({
    open,
    mode,
    draft,
    hosts,
    busy: isVerifying || isSubmitting || error !== null || verificationMessage !== null,
    onAdopt: onAdoptConnectionSource,
  });

  const changeSource = (source: RemoteProjectConnectionSource) => {
    if (!isEditing) rememberRemoteProjectConnectionSource(source);
    onFieldChange("connectionSource", source);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit remote project" : "Add remote project"}</DialogTitle>
          <DialogDescription>
            Open a project on another machine over SSH. bigbud checks the connection before{" "}
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
            <label htmlFor="remote-project-display-name" className="block sm:col-span-2">
              <span className="text-xs font-medium text-foreground">Display name</span>
              <Input
                id="remote-project-display-name"
                className={remoteProjectInputClassName}
                placeholder="Optional sidebar label"
                spellCheck={false}
                value={draft.displayName}
                onChange={(event) => onFieldChange("displayName", event.target.value)}
              />
            </label>

            {isSshConfig ? (
              <div className="sm:col-span-2">
                <SidebarRemoteProjectSshConfigHostField
                  draft={draft}
                  fieldErrors={fieldErrors}
                  hosts={hosts}
                  onFieldChange={onFieldChange}
                  onUseManual={() => changeSource("manual")}
                />
              </div>
            ) : (
              <SidebarRemoteProjectManualFields
                draft={draft}
                fieldErrors={fieldErrors}
                onFieldChange={onFieldChange}
              />
            )}

            <div className="sm:col-span-2">
              <SidebarRemoteProjectPathField
                draft={draft}
                fieldErrors={fieldErrors}
                onFieldChange={onFieldChange}
                onRequestUnlock={onRequestUnlock}
              />
            </div>
          </div>

          <RemoteProjectConnectionOptions draft={draft} onFieldChange={onFieldChange} />

          {isSshConfig ? (
            <SidebarRemoteProjectSshConfigAdvanced
              draft={draft}
              fieldErrors={fieldErrors}
              onFieldChange={onFieldChange}
            />
          ) : (
            <RemoteProjectAuthenticationFields draft={draft} onFieldChange={onFieldChange} />
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
                  : "Add remote project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

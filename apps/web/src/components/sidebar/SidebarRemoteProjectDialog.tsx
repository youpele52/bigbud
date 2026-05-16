import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import type { RemoteProjectAuthMode, RemoteProjectDraft } from "./Sidebar.projects.logic";
import type { ProviderRuntimeLocation } from "../../lib/providerExecutionTargets";

type RemoteProjectField =
  | "displayName"
  | "host"
  | "username"
  | "port"
  | "workspaceRoot"
  | "sshKeyPath";

type RemoteProjectFieldErrors = Partial<Record<RemoteProjectField, string>>;

const remoteProjectInputClassName =
  "mt-1.5 flex border-border bg-card font-sans has-focus-visible:border-ring/45 has-focus-visible:ring-0 [&_input]:placeholder:text-xs [&_input]:placeholder:tracking-normal";

interface SidebarRemoteProjectDialogProps {
  open: boolean;
  draft: RemoteProjectDraft;
  fieldErrors: RemoteProjectFieldErrors;
  error: string | null;
  verificationMessage: string | null;
  isSubmitting: boolean;
  isVerifying: boolean;
  onOpenChange: (open: boolean) => void;
  onFieldChange: <K extends RemoteProjectField | "authMode" | "providerRuntimeLocation">(
    field: K,
    value: K extends "authMode"
      ? RemoteProjectAuthMode
      : K extends "providerRuntimeLocation"
        ? ProviderRuntimeLocation
        : string,
  ) => void;
  onSubmit: () => void;
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) {
    return null;
  }
  return <p className="text-destructive text-xs leading-4">{message}</p>;
}

function AuthModeButton({
  active,
  disabled = false,
  description,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  description: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`rounded-xl border px-4 py-3 text-left transition-colors ${
        active
          ? "border-primary/35 bg-primary/8 text-foreground shadow-xs/5"
          : "border-border/70 bg-muted/24 text-foreground/90 hover:bg-accent/50"
      }`}
      onClick={onClick}
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
    </button>
  );
}

export function SidebarRemoteProjectDialog({
  open,
  draft,
  fieldErrors,
  error,
  verificationMessage,
  isSubmitting,
  isVerifying,
  onOpenChange,
  onFieldChange,
  onSubmit,
}: SidebarRemoteProjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add SSH remote project</DialogTitle>
          <DialogDescription>
            BigBud verifies the SSH target before it creates the remote project. You can keep the
            provider runtime local or run it on the remote host.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
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

            <label htmlFor="remote-project-host" className="block">
              <span className="text-xs font-medium text-foreground">Host or IP</span>
              <Input
                id="remote-project-host"
                aria-invalid={fieldErrors.host ? true : undefined}
                className={remoteProjectInputClassName}
                placeholder="devbox or 192.168.1.10"
                spellCheck={false}
                value={draft.host}
                onChange={(event) => onFieldChange("host", event.target.value)}
              />
              <FieldError message={fieldErrors.host} />
            </label>

            <label htmlFor="remote-project-username" className="block">
              <span className="text-xs font-medium text-foreground">Username</span>
              <Input
                id="remote-project-username"
                className={remoteProjectInputClassName}
                placeholder="Optional"
                spellCheck={false}
                value={draft.username}
                onChange={(event) => onFieldChange("username", event.target.value)}
              />
            </label>

            <label htmlFor="remote-project-port" className="block">
              <span className="text-xs font-medium text-foreground">Port</span>
              <Input
                id="remote-project-port"
                aria-invalid={fieldErrors.port ? true : undefined}
                className={`${remoteProjectInputClassName} max-w-48`}
                inputMode="numeric"
                placeholder="22"
                spellCheck={false}
                value={draft.port}
                onChange={(event) => onFieldChange("port", event.target.value)}
              />
              <FieldError message={fieldErrors.port} />
            </label>

            <label htmlFor="remote-project-path" className="block sm:col-span-2">
              <span className="text-xs font-medium text-foreground">Remote project path</span>
              <Input
                id="remote-project-path"
                aria-invalid={fieldErrors.workspaceRoot ? true : undefined}
                className={remoteProjectInputClassName}
                placeholder="/srv/app or ~/workspace/project"
                spellCheck={false}
                value={draft.workspaceRoot}
                onChange={(event) => onFieldChange("workspaceRoot", event.target.value)}
              />
              <FieldError message={fieldErrors.workspaceRoot} />
            </label>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-foreground">Provider runtime</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <AuthModeButton
                active={draft.providerRuntimeLocation === "local"}
                description="Run the provider on this machine while using the remote workspace."
                label="Local runtime"
                onClick={() => onFieldChange("providerRuntimeLocation", "local")}
              />
              <AuthModeButton
                active={draft.providerRuntimeLocation === "remote"}
                description="Run the provider CLI on the remote host. Requires the CLI and auth there."
                label="Remote runtime"
                onClick={() => onFieldChange("providerRuntimeLocation", "remote")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-foreground">Authentication</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <AuthModeButton
                active={draft.authMode === "ssh-key"}
                description="Use your default SSH agent or an optional key path."
                label="SSH key"
                onClick={() => onFieldChange("authMode", "ssh-key")}
              />
              <AuthModeButton
                active={draft.authMode === "password"}
                disabled
                description="Password auth is not implemented for remote execution yet."
                label="Password"
                onClick={() => undefined}
              />
            </div>
          </div>

          {draft.authMode === "ssh-key" ? (
            <label htmlFor="remote-project-key" className="block">
              <span className="text-xs font-medium text-foreground">SSH key path</span>
              <Input
                id="remote-project-key"
                className={remoteProjectInputClassName}
                placeholder="Optional, e.g. ~/.ssh/id_ed25519"
                spellCheck={false}
                value={draft.sshKeyPath}
                onChange={(event) => onFieldChange("sshKeyPath", event.target.value)}
              />
            </label>
          ) : null}

          {verificationMessage ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-emerald-700 text-xs leading-4 dark:text-emerald-300">
              {verificationMessage}
            </div>
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
            {isSubmitting ? "Adding..." : isVerifying ? "Verifying..." : "Add remote project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

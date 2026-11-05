import { Input } from "../ui/input";
import type {
  RemoteWorkspaceDraft,
  UpdateRemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";
import {
  FieldError,
  remoteWorkspaceInputClassName,
  type RemoteWorkspaceFieldErrors,
} from "./SidebarRemoteWorkspaceDialog.options";

/** Host, username, and port typed by hand; rendered inside the dialog's two-column grid. */
export function SidebarRemoteWorkspaceManualFields({
  draft,
  fieldErrors,
  onFieldChange,
}: {
  draft: RemoteWorkspaceDraft;
  fieldErrors: RemoteWorkspaceFieldErrors;
  onFieldChange: UpdateRemoteWorkspaceDraft;
}) {
  return (
    <>
      <label htmlFor="remote-workspace-host" className="block">
        <span className="text-xs font-medium text-foreground">Host or IP</span>
        <Input
          id="remote-workspace-host"
          aria-invalid={fieldErrors.host ? true : undefined}
          className={remoteWorkspaceInputClassName}
          placeholder="devbox or 192.168.1.10"
          spellCheck={false}
          value={draft.host}
          onChange={(event) => onFieldChange("host", event.target.value)}
        />
        <FieldError message={fieldErrors.host} />
      </label>

      <label htmlFor="remote-workspace-username" className="block">
        <span className="text-xs font-medium text-foreground">Username</span>
        <Input
          id="remote-workspace-username"
          className={remoteWorkspaceInputClassName}
          placeholder="Optional"
          spellCheck={false}
          value={draft.username}
          onChange={(event) => onFieldChange("username", event.target.value)}
        />
      </label>

      <label htmlFor="remote-workspace-port" className="block">
        <span className="text-xs font-medium text-foreground">Port</span>
        <Input
          id="remote-workspace-port"
          aria-invalid={fieldErrors.port ? true : undefined}
          className={`${remoteWorkspaceInputClassName} max-w-48`}
          inputMode="numeric"
          placeholder="22"
          spellCheck={false}
          value={draft.port}
          onChange={(event) => onFieldChange("port", event.target.value)}
        />
        <FieldError message={fieldErrors.port} />
      </label>
    </>
  );
}

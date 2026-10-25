import { Input } from "../ui/input";
import type { RemoteProjectDraft, UpdateRemoteProjectDraft } from "./Sidebar.projects.logic";
import {
  FieldError,
  remoteProjectInputClassName,
  type RemoteProjectFieldErrors,
} from "./SidebarRemoteProjectDialog.options";

/** Host, username, and port typed by hand; rendered inside the dialog's two-column grid. */
export function SidebarRemoteProjectManualFields({
  draft,
  fieldErrors,
  onFieldChange,
}: {
  draft: RemoteProjectDraft;
  fieldErrors: RemoteProjectFieldErrors;
  onFieldChange: UpdateRemoteProjectDraft;
}) {
  return (
    <>
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
    </>
  );
}

import { FolderOpenIcon } from "lucide-react";
import { useMemo } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  createRemoteWorkspaceExecutionTargetId,
  isBroadRemoteWorkspaceRoot,
  type RemoteWorkspaceDraft,
  type RequestRemoteWorkspaceUnlock,
  type UpdateRemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";
import { useRemoteFolderBrowser } from "./SidebarRemoteWorkspaceDialog.folderBrowser";
import { RemoteFolderBrowserPanel } from "./SidebarRemoteWorkspaceDialog.folderBrowserPanel";
import {
  FieldError,
  remoteWorkspaceInputClassName,
  type RemoteWorkspaceFieldErrors,
} from "./SidebarRemoteWorkspaceDialog.options";

/** Remote workspace path with a Browse button that lists folders on the host over SSH. */
export function SidebarRemoteWorkspacePathField({
  draft,
  fieldErrors,
  onFieldChange,
  onRequestUnlock,
}: {
  draft: RemoteWorkspaceDraft;
  fieldErrors: RemoteWorkspaceFieldErrors;
  onFieldChange: UpdateRemoteWorkspaceDraft;
  onRequestUnlock: RequestRemoteWorkspaceUnlock;
}) {
  const executionTargetId = useMemo(
    () => (draft.host.trim() ? createRemoteWorkspaceExecutionTargetId(draft) : null),
    [draft],
  );
  const browser = useRemoteFolderBrowser({ executionTargetId, requestUnlock: onRequestUnlock });
  const path = draft.workspaceRoot.trim();
  const showBroadWarning = path.length > 0 && isBroadRemoteWorkspaceRoot(path, browser.homePath);

  return (
    <div>
      <label htmlFor="remote-workspace-path" className="block">
        <span className="text-xs font-medium text-foreground">Remote workspace path</span>
      </label>
      <div className="mt-1.5 flex items-start gap-2">
        <Input
          id="remote-workspace-path"
          aria-invalid={fieldErrors.workspaceRoot ? true : undefined}
          className={`${remoteWorkspaceInputClassName} mt-0 min-w-0 flex-1`}
          placeholder="Browse, or type e.g. ~/workspace/project"
          spellCheck={false}
          value={draft.workspaceRoot}
          onChange={(event) => onFieldChange("workspaceRoot", event.target.value)}
        />
        <Button
          variant="outline"
          disabled={!executionTargetId}
          title={executionTargetId ? undefined : "Choose a host first"}
          onClick={() => browser.load(path || undefined)}
        >
          <FolderOpenIcon aria-hidden className="size-4" />
          Browse
        </Button>
      </div>
      <FieldError message={fieldErrors.workspaceRoot} />
      <RemoteFolderBrowserPanel
        state={browser.state}
        onNavigate={browser.load}
        onChoose={(chosen) => {
          onFieldChange("workspaceRoot", chosen);
          browser.close();
        }}
        onClose={browser.close}
      />
      {showBroadWarning ? (
        <p className="mt-1.5 text-amber-700 text-xs leading-4 dark:text-amber-300">
          This makes {path === "/" ? "the whole machine" : "your whole home folder"} the workspace.
          bigbud will watch and search all of it over SSH, which can be slow, and agents can work
          anywhere inside it. Pick a project folder instead if you can.
        </p>
      ) : null}
    </div>
  );
}

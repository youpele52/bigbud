import { FolderOpenIcon } from "lucide-react";
import { useMemo } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  createRemoteProjectExecutionTargetId,
  isBroadRemoteProjectRoot,
  type RemoteProjectDraft,
  type RequestRemoteProjectUnlock,
  type UpdateRemoteProjectDraft,
} from "./Sidebar.projects.logic";
import { useRemoteFolderBrowser } from "./SidebarRemoteProjectDialog.folderBrowser";
import { RemoteFolderBrowserPanel } from "./SidebarRemoteProjectDialog.folderBrowserPanel";
import {
  FieldError,
  remoteProjectInputClassName,
  type RemoteProjectFieldErrors,
} from "./SidebarRemoteProjectDialog.options";

/** Remote project path with a Browse button that lists folders on the host over SSH. */
export function SidebarRemoteProjectPathField({
  draft,
  fieldErrors,
  onFieldChange,
  onRequestUnlock,
}: {
  draft: RemoteProjectDraft;
  fieldErrors: RemoteProjectFieldErrors;
  onFieldChange: UpdateRemoteProjectDraft;
  onRequestUnlock: RequestRemoteProjectUnlock;
}) {
  const executionTargetId = useMemo(
    () => (draft.host.trim() ? createRemoteProjectExecutionTargetId(draft) : null),
    [draft],
  );
  const browser = useRemoteFolderBrowser({ executionTargetId, requestUnlock: onRequestUnlock });
  const path = draft.workspaceRoot.trim();
  const showBroadWarning = path.length > 0 && isBroadRemoteProjectRoot(path, browser.homePath);

  return (
    <div>
      <label htmlFor="remote-project-path" className="block">
        <span className="text-xs font-medium text-foreground">Remote project path</span>
      </label>
      <div className="mt-1.5 flex items-start gap-2">
        <Input
          id="remote-project-path"
          aria-invalid={fieldErrors.workspaceRoot ? true : undefined}
          className={`${remoteProjectInputClassName} mt-0 min-w-0 flex-1`}
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
          This makes {path === "/" ? "the whole machine" : "your whole home folder"} the project.
          bigbud will watch and search all of it over SSH, which can be slow, and agents can work
          anywhere inside it. Pick a project folder instead if you can.
        </p>
      ) : null}
    </div>
  );
}

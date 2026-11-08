import { useState, type RefObject } from "react";
import { FolderOpenIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Alert, AlertDescription } from "../ui/alert";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { deriveProjectTitleFromCwd } from "./Sidebar.remoteWorkspaces.logic";
import { remoteWorkspaceInputClassName } from "./SidebarRemoteWorkspaceDialog.options";

interface SidebarNewProjectFlowProps {
  isElectron: boolean;
  newCwd: string;
  isPickingFolder: boolean;
  isAddingProject: boolean;
  addProjectError: string | null;
  addProjectInputRef: RefObject<HTMLInputElement | null>;
  onCwdChange: (cwd: string) => void;
  onClearError: () => void;
  onPickFolder: () => void;
  onAdd: (title: string) => void;
  onCancel: () => void;
}

export function SidebarNewProjectFlow(props: SidebarNewProjectFlowProps) {
  const [name, setName] = useState<string | null>(null);
  const title = name ?? (props.newCwd ? deriveProjectTitleFromCwd(props.newCwd) : "");
  const busy = props.isAddingProject || props.isPickingFolder;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onCancel();
      }}
    >
      <DialogPopup className="max-w-sm" showCloseButton={!busy}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() && !busy) props.onAdd(title.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>
              Give your project a name and optionally choose a folder.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label htmlFor="new-project-name" className="block">
              <span className="text-xs font-medium text-foreground">Project name</span>
              <Input
                id="new-project-name"
                ref={props.addProjectInputRef}
                autoFocus
                required
                className={remoteWorkspaceInputClassName}
                value={title}
                placeholder="Project name"
                disabled={busy}
                onChange={(event) => {
                  setName(event.target.value);
                  props.onClearError();
                }}
              />
            </label>
            <div>
              <label htmlFor="new-project-folder" className="block">
                <span className="text-xs font-medium text-foreground">Folder (optional)</span>
              </label>
              <div className="mt-1.5 flex items-start gap-2">
                <Input
                  id="new-project-folder"
                  className={`${remoteWorkspaceInputClassName} mt-0 min-w-0 flex-1`}
                  placeholder="Choose a folder"
                  spellCheck={false}
                  value={props.newCwd}
                  readOnly
                  disabled={busy}
                />
                {props.isElectron ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={props.onPickFolder}
                  >
                    <FolderOpenIcon aria-hidden className="size-4" />
                    {props.isPickingFolder ? "Picking…" : "Browse"}
                  </Button>
                ) : null}
              </div>
              {props.newCwd ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    props.onCwdChange("");
                    props.onClearError();
                  }}
                >
                  Clear folder
                </Button>
              ) : null}
              {!props.isElectron ? (
                <p className="text-xs text-muted-foreground">
                  Open the desktop app to browse for a local folder.
                </p>
              ) : null}
            </div>
            {props.addProjectError ? (
              <Alert variant="error" className="text-xs leading-4">
                <AlertDescription>{props.addProjectError}</AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={props.onCancel}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!title.trim() || busy}>
              {props.isAddingProject ? "Adding…" : "Add project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

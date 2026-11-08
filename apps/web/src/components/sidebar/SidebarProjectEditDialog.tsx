import { useRef, useState } from "react";
import { newCommandId } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { useQueryClient } from "@tanstack/react-query";
import type { Project } from "../../models/types";
import { useStore } from "../../stores/main";
import { readNativeApi } from "../../rpc/nativeApi";
import { isElectron } from "../../config/env";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Alert, AlertDescription } from "../ui/alert";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { saveLocalProject, useProjectEditor } from "./Sidebar.projectEdit.logic";
import { ProjectEditRecoveryGate } from "./SidebarProjectEditRecovery";

export function SidebarProjectEditDialog() {
  const { projectId, close } = useProjectEditor();
  const [busy, setBusy] = useState(false);
  const project = useStore((state) => state.projects.find((entry) => entry.id === projectId));
  return (
    <Dialog
      open={projectId !== null}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      {project ? (
        <ProjectEditRecoveryGate
          key={project.id}
          projectId={project.id}
          onClose={close}
          onBusyChange={setBusy}
        >
          {(initialError) => (
            <ProjectEditor
              project={project}
              onClose={close}
              onBusyChange={setBusy}
              initialError={initialError}
            />
          )}
        </ProjectEditRecoveryGate>
      ) : null}
    </Dialog>
  );
}

function ProjectEditor({
  project,
  onClose,
  onBusyChange,
  initialError,
}: {
  initialError: string | null;
  project: Project;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [baseline] = useState(project);
  const [title, setTitle] = useState(project.name);
  const [directory, setDirectory] = useState(project.cwd ?? "");
  const [action, setAction] = useState<"switch" | "transfer">();
  const [requiresNativeReset, setRequiresNativeReset] = useState(
    initialError?.includes("Explicit Muse native-context reset confirmation") ?? false,
  );
  const [nativeContextReset, setNativeContextReset] = useState(false);
  const request = useRef<{ key: string; commandId: ReturnType<typeof newCommandId> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const busy = saving || picking;
  const [error, setError] = useState<string | null>(initialError);
  const queryClient = useQueryClient();
  const changed = directory.trim() !== (baseline.cwd ?? "");
  const managed = baseline.workspaceKind === "managed";
  const submit = async () => {
    if (busy || !title.trim() || !directory.trim()) return;
    setSaving(true);
    onBusyChange(true);
    setError(null);
    try {
      const key = JSON.stringify({ title, directory, action, nativeContextReset });
      if (request.current?.key !== key) request.current = { key, commandId: newCommandId() };
      await saveLocalProject({
        project: baseline,
        title,
        directory,
        action,
        nativeContextReset,
        commandId: request.current.commandId,
      });
      if (changed) {
        const folders = new Set([baseline.cwd, directory.trim()]);
        await queryClient.invalidateQueries({
          predicate: ({ queryKey }) =>
            (queryKey[0] === "projects" || queryKey[0] === "git") &&
            queryKey[2] === "local" &&
            typeof queryKey[3] === "string" &&
            folders.has(queryKey[3]),
        });
      }
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (message.includes("Explicit Muse native-context reset confirmation"))
        setRequiresNativeReset(true);
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  };
  const pickFolder = async () => {
    if (busy) return;
    setPicking(true);
    onBusyChange(true);
    setError(null);
    try {
      const folder = await readNativeApi()?.dialogs.pickFolder();
      if (folder) {
        setDirectory(folder);
        setAction(undefined);
        setNativeContextReset(false);
        setRequiresNativeReset(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPicking(false);
      onBusyChange(false);
    }
  };
  const reveal = async (location: string) => {
    try {
      await readNativeApi()?.shell.openPath(location);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <DialogPopup className="max-w-sm" showCloseButton={!busy}>
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>
            Keep the same project, threads, notes, cards, and history.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-foreground">Project name</span>
            <Input
              className="mt-1.5"
              autoFocus
              value={title}
              required
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="space-y-1 text-xs text-muted-foreground">
            {managed ? <p>Managed by bigbud</p> : null}
            <p className="break-all">Current location: {baseline.cwd ?? "No directory"}</p>
            {isElectron && baseline.cwd ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void reveal(baseline.cwd!)}
              >
                Reveal current folder
              </Button>
            ) : null}
            {baseline.previousWorkspaceRoot ? (
              <div className="space-y-1">
                <p className="break-all">
                  Previous folder retained: {baseline.previousWorkspaceRoot}
                </p>
                {isElectron ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void reveal(baseline.previousWorkspaceRoot!)}
                  >
                    Reveal previous folder
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">Folder</span>
            <div className="flex items-center gap-2">
              <p
                aria-label="Selected folder"
                className="min-w-0 flex-1 break-all rounded-md border px-3 py-2 text-sm text-muted-foreground"
              >
                {directory || (managed ? "Managed by bigbud" : "No folder selected")}
              </p>
              {isElectron ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void pickFolder()}
                >
                  {picking ? "Picking…" : "Browse"}
                </Button>
              ) : null}
            </div>
            {changed ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDirectory(baseline.cwd ?? "");
                  setAction(undefined);
                  setNativeContextReset(false);
                  setRequiresNativeReset(false);
                }}
              >
                Reset folder
              </Button>
            ) : null}
            {!isElectron ? (
              <p className="text-xs text-muted-foreground">
                Open the desktop app to browse for a local folder.
              </p>
            ) : null}
          </div>
          {changed && managed ? (
            <fieldset disabled={busy} className="space-y-2 text-sm">
              <legend className="mb-2">
                If this workspace contains files, choose what happens to them
              </legend>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="workspace-action"
                  checked={action === "switch"}
                  onChange={() => setAction("switch")}
                />
                <span>
                  Switch without moving files
                  <span className="block text-xs text-muted-foreground">
                    Files stay in the previous folder. Its location remains available here.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="workspace-action"
                  checked={action === "transfer"}
                  onChange={() => setAction("transfer")}
                />
                <span>
                  Transfer files
                  <span className="block text-xs text-muted-foreground">
                    Copies files to the selected empty folder and keeps the original as a recovery
                    copy. Never merges or overwrites files.
                  </span>
                </span>
              </label>
            </fieldset>
          ) : null}
          {changed && requiresNativeReset ? (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={nativeContextReset}
                onCheckedChange={setNativeContextReset}
                disabled={busy}
                aria-label="Allow Muse conversations to start fresh"
              />
              <span>
                Allow Muse conversations to start fresh
                <span className="block text-xs text-muted-foreground">
                  Your messages stay here. Muse's provider-side context starts over in the new
                  folder, using each thread's selected provider and model on next use. Previous Muse
                  sessions are archived for recovery; their context does not carry into the fresh
                  session.
                </span>
              </span>
            </label>
          ) : null}
          {changed ? (
            <p className="text-xs text-muted-foreground">
              Stop active work and close project terminals first. Detach retained worktrees before
              changing folders. Some provider conversations require confirmation or supported native
              relocation; unsafe changes are refused. Rename remains available.
            </p>
          ) : null}
          {error ? (
            <Alert variant="error" className="text-xs leading-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={
              busy ||
              !title.trim() ||
              !directory.trim() ||
              (changed && requiresNativeReset && !nativeContextReset)
            }
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}

import { useState } from "react";
import type { WorktreeEntry } from "@bigbud/contracts/workspace/worktrees.ts";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { WorktreeIcon } from "./WorktreeIcon";

export type WorktreeDialogTarget = { kind: "create" | "delete"; entry?: WorktreeEntry };

export function WorktreeToolbarDialog(props: {
  target: WorktreeDialogTarget;
  baseBranch: string;
  onClose: () => void;
  onSubmit: (values: { name: string; branch: string; newBranch: string }) => Promise<void>;
}) {
  const [name, setName] = useState(props.target.entry?.name ?? "");
  const [branch, setBranch] = useState(props.baseBranch);
  const [newBranch, setNewBranch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const kind = props.target.kind;
  const submit = async () => {
    setPending(true);
    setError("");
    try {
      await props.onSubmit({ name, branch, newBranch });
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WorktreeIcon />
            {kind === "create" ? "Create worktree" : "Delete worktree"}
          </DialogTitle>
          <DialogDescription>
            {kind === "delete"
              ? "Only an unreferenced, clean linked worktree can be removed. Its branch is retained; nothing is forced."
              : "Create a physical worktree now. Folder name and branch name are independent."}
          </DialogDescription>
        </DialogHeader>
        {props.target.entry && (
          <p className="my-3 break-all text-xs text-muted-foreground">{props.target.entry.path}</p>
        )}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {kind !== "delete" && (
            <label className="block text-sm">
              Folder name
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                disabled={pending}
                required
              />
            </label>
          )}
          {kind === "create" && (
            <>
              <label className="block text-sm">
                Base branch
                <Input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  required
                  disabled={pending}
                />
              </label>
              <label className="block text-sm">
                New branch name
                <Input
                  value={newBranch}
                  onChange={(event) => setNewBranch(event.target.value)}
                  required
                  disabled={pending}
                />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={kind === "delete" ? "destructive" : "default"}
              disabled={pending}
            >
              {pending ? "Working…" : kind === "create" ? "Create worktree" : "Delete worktree"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

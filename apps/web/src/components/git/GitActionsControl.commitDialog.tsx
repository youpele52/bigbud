import type { GitStatusResult } from "@bigbud/contracts";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

interface CommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gitStatus: GitStatusResult | null;
  isDefaultBranch: boolean;
  dialogCommitMessage: string;
  onCommitMessageChange: (message: string) => void;
  excludedFiles: ReadonlySet<string>;
  onExcludedFilesChange: (files: ReadonlySet<string>) => void;
  isEditingFiles: boolean;
  onEditingFilesChange: (editing: boolean) => void;
  onCancel: () => void;
  onCommitOnNewBranch: () => void;
  onCommit: () => void;
  onOpenChangedFileInEditor: (filePath: string) => void;
}

export function CommitDialog({
  open,
  onOpenChange,
  gitStatus,
  isDefaultBranch,
  dialogCommitMessage,
  onCommitMessageChange,
  excludedFiles,
  onExcludedFilesChange,
  isEditingFiles,
  onEditingFilesChange,
  onCancel,
  onCommitOnNewBranch,
  onCommit,
  onOpenChangedFileInEditor,
}: CommitDialogProps) {
  const allFiles = gitStatus?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
          <DialogDescription>{COMMIT_DIALOG_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-3 rounded-lg border border-input bg-muted/40 p-3 text-xs">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">Branch</span>
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">{gitStatus?.branch ?? "(detached HEAD)"}</span>
                {isDefaultBranch && (
                  <span className="text-right text-warning text-xs">Warning: default branch</span>
                )}
              </span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isEditingFiles && allFiles.length > 0 && (
                    <Checkbox
                      checked={allSelected}
                      indeterminate={!allSelected && !noneSelected}
                      onCheckedChange={() => {
                        onExcludedFilesChange(
                          allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                        );
                      }}
                    />
                  )}
                  <span className="text-muted-foreground">Files</span>
                  {!allSelected && !isEditingFiles && (
                    <span className="text-muted-foreground">
                      ({selectedFiles.length} of {allFiles.length})
                    </span>
                  )}
                </div>
                {allFiles.length > 0 && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onEditingFilesChange(!isEditingFiles)}
                  >
                    {isEditingFiles ? "Done" : "Edit"}
                  </Button>
                )}
              </div>
              {!gitStatus || allFiles.length === 0 ? (
                <p className="font-medium">none</p>
              ) : (
                <div className="space-y-2">
                  <ScrollArea className="h-44 rounded-md border border-input bg-background">
                    <div className="space-y-1 p-1">
                      {allFiles.map((file) => {
                        const isExcluded = excludedFiles.has(file.path);
                        return (
                          <div
                            key={file.path}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors hover:bg-accent/50"
                          >
                            {isEditingFiles && (
                              <Checkbox
                                checked={!excludedFiles.has(file.path)}
                                onCheckedChange={() => {
                                  onExcludedFilesChange(
                                    (() => {
                                      const next = new Set(excludedFiles);
                                      if (next.has(file.path)) {
                                        next.delete(file.path);
                                      } else {
                                        next.add(file.path);
                                      }
                                      return next;
                                    })(),
                                  );
                                }}
                              />
                            )}
                            <button
                              type="button"
                              className="flex flex-1 items-center justify-between gap-3 text-left truncate"
                              onClick={() => onOpenChangedFileInEditor(file.path)}
                            >
                              <span
                                className={`truncate${isExcluded ? " text-muted-foreground" : ""}`}
                              >
                                {file.path}
                              </span>
                              <span className="shrink-0">
                                {isExcluded ? (
                                  <span className="text-muted-foreground">Excluded</span>
                                ) : (
                                  <>
                                    <span className="text-success">+{file.insertions}</span>
                                    <span className="text-muted-foreground"> / </span>
                                    <span className="text-destructive">-{file.deletions}</span>
                                  </>
                                )}
                              </span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                  <div className="flex justify-end font-mono">
                    <span className="text-success">
                      +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                    </span>
                    <span className="text-muted-foreground"> / </span>
                    <span className="text-destructive">
                      -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">Commit message (optional)</p>
            <Textarea
              value={dialogCommitMessage}
              onChange={(event) => onCommitMessageChange(event.target.value)}
              placeholder="Leave empty to auto-generate"
              size="sm"
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" disabled={noneSelected} onClick={onCommitOnNewBranch}>
            Commit on new branch
          </Button>
          <Button size="sm" disabled={noneSelected} onClick={onCommit}>
            Commit
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

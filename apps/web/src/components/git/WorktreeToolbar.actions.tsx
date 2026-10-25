import type { WorktreeEntry } from "@bigbud/contracts/workspace/worktrees.ts";
import { MenuItem, MenuSeparator } from "../ui/menu";
import { copyTextToClipboard } from "../../lib/clipboard/copyText";
import { readNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";
import { openInPreferredEditor } from "../../models/editor/preferences.models";

export function WorktreeToolbarActions(props: {
  entry: WorktreeEntry;
  local: boolean;
  disabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const copy = async (text: string) => {
    try {
      await copyTextToClipboard(text);
      toastManager.add({ type: "success", title: "Copied." });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not copy worktree details.",
        description: String(error),
      });
    }
  };
  const open = async () => {
    try {
      const api = readNativeApi();
      if (!api || !props.local)
        throw new Error("Opening a remote worktree in a local editor is not supported.");
      await openInPreferredEditor(api, props.entry.path);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open worktree.",
        description: String(error),
      });
    }
  };
  const unavailable =
    props.entry.bare || props.entry.locked !== null || props.entry.prunable !== null;
  return (
    <>
      <MenuItem disabled={props.disabled || unavailable || !props.local} onClick={props.onSelect}>
        Switch to worktree
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => void copy(props.entry.name)}>Copy worktree name</MenuItem>
      <MenuItem onClick={() => void copy(props.entry.path)}>Copy worktree path</MenuItem>
      <MenuItem disabled={!props.local} onClick={() => void open()}>
        Open in editor
      </MenuItem>
      {!props.entry.main && (
        <>
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            disabled={props.disabled || unavailable || !props.local}
            onClick={props.onDelete}
          >
            Delete…
          </MenuItem>
        </>
      )}
      {(unavailable || !props.local) && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {!props.local
            ? "Remote lifecycle changes are not supported here."
            : (props.entry.locked ?? props.entry.prunable ?? "Bare repository")}
        </div>
      )}
    </>
  );
}

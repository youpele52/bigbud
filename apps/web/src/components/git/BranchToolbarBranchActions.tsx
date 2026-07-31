import type { GitBranch } from "@bigbud/contracts";

import { copyTextToClipboard } from "~/lib/clipboard/copyText";
import { readNativeApi } from "~/rpc/nativeApi";

import { MenuItem, MenuSeparator } from "../ui/menu";
import { toastManager } from "../ui/toast";

export function BranchToolbarBranchActions(props: {
  branch: GitBranch;
  selectLabel: string;
  disabled?: boolean;
  onSelect: (branch: GitBranch) => void;
  onRenameRequest: (branch: GitBranch) => void;
  onDeleteRequest: (branch: GitBranch) => void;
}) {
  const canRename = !props.branch.isRemote && (!props.branch.worktreePath || props.branch.current);
  const canDelete =
    !props.branch.isRemote &&
    !props.branch.current &&
    !props.branch.isDefault &&
    !props.branch.worktreePath;

  const copyName = async () => {
    try {
      await copyTextToClipboard(props.branch.name);
      toastManager.add({ type: "success", title: "Branch name copied." });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to copy branch name.",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };

  const openWebLink = async (url: string) => {
    try {
      const api = readNativeApi();
      if (!api) throw new Error("Link opening is unavailable.");
      await api.shell.openExternal(url);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to open link.",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };

  const webLink = props.branch.webLink;
  const providerName = webLink?.provider === "github" ? "GitHub" : "GitLab";

  return (
    <>
      <MenuItem
        className="text-sm sm:text-sm"
        disabled={props.disabled}
        onClick={() => props.onSelect(props.branch)}
      >
        {props.selectLabel}
      </MenuItem>
      <MenuSeparator />
      <MenuItem className="text-sm sm:text-sm" onClick={() => void copyName()}>
        Copy branch name
      </MenuItem>
      {webLink ? (
        <MenuItem
          className="text-sm sm:text-sm"
          onClick={() => void openWebLink(webLink.branchUrl)}
        >
          View on {providerName}
        </MenuItem>
      ) : null}
      {canRename ? (
        <MenuItem
          className="text-sm sm:text-sm"
          onClick={() => props.onRenameRequest(props.branch)}
        >
          Rename
        </MenuItem>
      ) : null}
      {canDelete ? (
        <>
          <MenuSeparator />
          <MenuItem
            className="text-sm sm:text-sm"
            variant="destructive"
            onClick={() => props.onDeleteRequest(props.branch)}
          >
            Delete
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

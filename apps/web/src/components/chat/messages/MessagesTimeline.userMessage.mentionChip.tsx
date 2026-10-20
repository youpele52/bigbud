import { DumbbellIcon } from "lucide-react";
import { memo } from "react";
import { cn } from "~/lib/utils";
import { useTheme } from "../../../hooks/useTheme";
import { inferEntryKindFromPath } from "../../../lib/vscode-icons";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../view/composerInlineChip";
import {
  ChatFileTargetContextMenu,
  useChatFileTargetContextMenu,
} from "../common/ChatFileTargetContextMenu";
import { openChatFileTarget } from "../common/chatFileTargets";
import { VscodeEntryIcon } from "../common/VscodeEntryIcon";
import { normalizeMentionName, type MentionKind } from "./MessagesTimeline.userMessage.sources";

export const UserMessageMentionChip = memo(function UserMessageMentionChip(props: {
  label: string;
  rawValue?: string;
  mentionKind: MentionKind;
  targetPath?: string | null;
  workspaceRoot?: string | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const clickable = props.mentionKind === "plugin" || !!props.targetPath;
  const inferredPathKind =
    props.mentionKind === "path"
      ? inferEntryKindFromPath(props.rawValue ?? props.label)
      : undefined;
  const { contextMenuState, hideContextMenu, showContextMenu } = useChatFileTargetContextMenu();
  return (
    <>
      <span
        className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "mx-[1px]", clickable && "cursor-pointer")}
        title={
          clickable
            ? props.mentionKind === "path"
              ? "Double-click to open"
              : "Click to open"
            : undefined
        }
        onClick={
          props.mentionKind === "plugin"
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                const name = normalizeMentionName(
                  "plugin",
                  props.rawValue ?? props.label,
                  props.label,
                );
                window.location.assign(`/plugins/openai-public%3A${encodeURIComponent(name)}`);
              }
            : clickable && props.mentionKind !== "path"
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (props.targetPath)
                    openChatFileTarget(props.targetPath, props.workspaceRoot, "file");
                }
              : undefined
        }
        onDoubleClick={
          props.targetPath && props.mentionKind === "path"
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (props.targetPath)
                  openChatFileTarget(
                    props.targetPath,
                    props.workspaceRoot,
                    inferredPathKind ?? "file",
                  );
              }
            : undefined
        }
        onContextMenu={
          props.targetPath
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!props.targetPath) return;
                showContextMenu({
                  targetPath: props.targetPath,
                  workspaceRoot: props.workspaceRoot,
                  kind: inferredPathKind ?? "file",
                  x: event.clientX,
                  y: event.clientY,
                });
              }
            : undefined
        }
      >
        {props.mentionKind === "path" ? (
          <VscodeEntryIcon
            pathValue={props.label}
            kind={inferredPathKind ?? "file"}
            theme={resolvedTheme}
            className="shrink-0 opacity-85"
          />
        ) : props.mentionKind === "skill" ? (
          <DumbbellIcon className="size-3.5 shrink-0 opacity-85" />
        ) : (
          <span className="inline-flex shrink-0 rounded-sm border border-border/70 bg-background/60 px-1 py-0 text-[10px] font-semibold uppercase leading-none text-muted-foreground">
            {props.mentionKind}
          </span>
        )}
        <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
      </span>
      <ChatFileTargetContextMenu contextMenuState={contextMenuState} onClose={hideContextMenu} />
    </>
  );
});

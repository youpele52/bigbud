import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";
import type {
  ChatFileAttachment,
  ChatPathAttachment,
  ChatThreadAttachment,
} from "../../../models/types/app.types";
import { resolveMarkdownFileLinkTarget } from "../../../utils/markdown";
import { cn } from "~/lib/utils";
import {
  ChatFileTargetContextMenu,
  useChatFileTargetContextMenu,
} from "../common/ChatFileTargetContextMenu";
import { VscodeEntryIcon } from "../common/VscodeEntryIcon";
import { openChatFileTarget } from "../common/chatFileTargets";

type UserFileReference = ChatFileAttachment | ChatPathAttachment;
type UserFileWithSourcePath = ChatFileAttachment & { sourcePath: string };
type VscodeIconTheme = "light" | "dark";

export function UserThreadReferenceChips(props: { threads: ReadonlyArray<ChatThreadAttachment> }) {
  const navigate = useNavigate();

  if (props.threads.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {props.threads.map((thread) => (
        <button
          type="button"
          key={thread.id}
          className="flex min-w-0 max-w-[180px] cursor-pointer items-center gap-1.5 rounded-md border border-border/50 bg-background/40 px-1.5 py-1 text-left transition-colors hover:bg-background/60"
          title={`Open thread: ${thread.title}`}
          onClick={() => {
            void navigate({ to: "/$threadId", params: { threadId: thread.threadId } });
          }}
        >
          <MessageSquareIcon className="size-3 shrink-0 opacity-60" />
          <span className="min-w-0 truncate text-[11px] text-muted-foreground/60">
            {thread.title}
          </span>
        </button>
      ))}
    </div>
  );
}

function openChatFilePath(path: string, markdownCwd: string | undefined): void {
  const targetPath = resolveMarkdownFileLinkTarget(path, markdownCwd);
  if (!targetPath) return;
  openChatFileTarget(targetPath, markdownCwd);
}

export function UserFileReferenceChips(props: {
  files: ReadonlyArray<UserFileReference>;
  markdownCwd: string | undefined;
  resolvedTheme: VscodeIconTheme;
}) {
  const { contextMenuState, hideContextMenu, showContextMenu } = useChatFileTargetContextMenu();

  if (props.files.length === 0) return null;

  return (
    <>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {props.files.map((file) => {
          const filePath = file.type === "path" ? file.path : file.sourcePath;
          const fileTargetPath = filePath
            ? resolveMarkdownFileLinkTarget(filePath, props.markdownCwd)
            : null;
          const kind =
            file.type === "path" && file.entryKind === "directory" ? "directory" : "file";
          return (
            <div
              key={file.id}
              className={cn(
                "flex min-w-0 max-w-[180px] items-center gap-1.5 rounded-md border border-border/50 bg-background/40 px-1.5 py-1",
                fileTargetPath && "cursor-pointer",
              )}
              title={fileTargetPath ? "Double-click to open" : undefined}
              onDoubleClick={
                fileTargetPath
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openChatFilePath(fileTargetPath, props.markdownCwd);
                    }
                  : undefined
              }
              onContextMenu={
                fileTargetPath
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      showContextMenu({
                        targetPath: fileTargetPath,
                        workspaceRoot: props.markdownCwd,
                        kind,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }
                  : undefined
              }
            >
              <VscodeEntryIcon
                pathValue={file.type === "path" ? file.path : (file.sourcePath ?? file.name)}
                kind={kind}
                theme={props.resolvedTheme}
                className="shrink-0 opacity-60"
              />
              <span
                className="min-w-0 truncate text-[11px] text-muted-foreground/60"
                title={file.type === "path" ? file.path : file.name}
              >
                {file.name}
              </span>
            </div>
          );
        })}
      </div>
      <ChatFileTargetContextMenu contextMenuState={contextMenuState} onClose={hideContextMenu} />
    </>
  );
}

export function UserFileSourcePaths(props: {
  files: ReadonlyArray<UserFileWithSourcePath>;
  markdownCwd: string | undefined;
  resolvedTheme: VscodeIconTheme;
}) {
  const { contextMenuState, hideContextMenu, showContextMenu } = useChatFileTargetContextMenu();

  if (props.files.length === 0) return null;

  return (
    <>
      <details className="mb-2 group/files">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/50 hover:text-muted-foreground/70">
          <ChevronDownIcon className="size-3 shrink-0 transition-transform duration-150 group-open/files:rotate-0 -rotate-90" />
          {props.files.length === 1 ? "1 attached file" : `${props.files.length} attached files`}
        </summary>
        <div className="mt-1.5 space-y-1 pl-1">
          {props.files.map((file) => (
            <div
              key={`path-${file.id}`}
              className="flex min-w-0 cursor-pointer items-start gap-1.5"
              title="Double-click to open"
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openChatFilePath(file.sourcePath, props.markdownCwd);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const targetPath = resolveMarkdownFileLinkTarget(
                  file.sourcePath,
                  props.markdownCwd,
                );
                if (!targetPath) return;
                showContextMenu({
                  targetPath,
                  workspaceRoot: props.markdownCwd,
                  kind: "file",
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <VscodeEntryIcon
                pathValue={file.sourcePath}
                kind="file"
                theme={props.resolvedTheme}
                className="mt-0.5 shrink-0 opacity-50"
              />
              <div
                className="min-w-0 break-all text-[11px] text-muted-foreground/45"
                title={file.sourcePath}
              >
                {file.sourcePath}
              </div>
            </div>
          ))}
        </div>
      </details>
      <ChatFileTargetContextMenu contextMenuState={contextMenuState} onClose={hideContextMenu} />
    </>
  );
}

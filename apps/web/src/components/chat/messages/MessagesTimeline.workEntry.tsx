import { memo, useMemo, useState } from "react";
import { type ExecutionTargetId, LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  KeyRoundIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";
import { Button } from "../../ui/button";
import { MessageCopyButton } from "../common/MessageCopyButton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../../../rpc/nativeApi";
import { getPassphraseProtectedSshKeyPath } from "../../../lib/ssh";
import { SidebarUnlockSshKeyDialog } from "../../sidebar/SidebarUnlockSshKeyDialog";
import { toastManager } from "../../ui/toast";

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];

export function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

export function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-destructive-foreground/80";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/65";
  return "text-muted-foreground/40";
}

export function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
): string | null {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

export function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  const isBrowserTool =
    workEntry.toolTitle && /browser|navigate|screenshot|web_search/i.test(workEntry.toolTitle);

  if (isBrowserTool) return GlobeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function workEntryCopyText(workEntry: TimelineWorkEntry): string {
  const lines: string[] = [];
  const appendLine = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    if (lines.at(-1) === trimmed) {
      return;
    }
    lines.push(trimmed);
  };

  appendLine(toolWorkEntryHeading(workEntry));
  appendLine(workEntryRawCommand(workEntry) ?? workEntry.command ?? workEntry.detail);
  if ((workEntry.changedFiles?.length ?? 0) > 0) {
    appendLine(`Changed files:\n${workEntry.changedFiles!.join("\n")}`);
  }

  return lines.join("\n");
}

export const WorkEntryActionButtons = memo(function WorkEntryActionButtons(props: {
  workEntry: TimelineWorkEntry;
  executionTargetId?: ExecutionTargetId | undefined;
  className?: string;
}) {
  const { workEntry, executionTargetId, className } = props;
  const copyText = workEntryCopyText(workEntry);
  const [isUnlockDialogOpen, setIsUnlockDialogOpen] = useState(false);
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");
  const [sshKeyUnlockError, setSshKeyUnlockError] = useState<string | null>(null);
  const [isUnlockingSshKey, setIsUnlockingSshKey] = useState(false);
  const sshKeyPath = useMemo(
    () =>
      executionTargetId && executionTargetId !== LOCAL_EXECUTION_TARGET_ID
        ? getPassphraseProtectedSshKeyPath(workEntry.detail)
        : null,
    [executionTargetId, workEntry.detail],
  );

  const submitSshKeyUnlock = async () => {
    const passphrase = sshKeyPassphrase.trim();
    if (!sshKeyPath || !executionTargetId || executionTargetId === LOCAL_EXECUTION_TARGET_ID) {
      return;
    }
    if (passphrase.length === 0) {
      setSshKeyUnlockError("Enter the SSH key passphrase.");
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setSshKeyUnlockError("Native API not found.");
      return;
    }

    setIsUnlockingSshKey(true);
    setSshKeyUnlockError(null);
    try {
      await api.server.unlockSshKey({
        executionTargetId,
        passphrase,
      });
      setIsUnlockDialogOpen(false);
      setSshKeyPassphrase("");
      toastManager.add({
        type: "success",
        title: "SSH key unlocked",
        description: "Retry the turn now that the remote SSH key is available.",
      });
    } catch (error) {
      setSshKeyUnlockError(
        error instanceof Error ? error.message : "Failed to unlock the SSH key.",
      );
    } finally {
      setIsUnlockingSshKey(false);
    }
  };

  return (
    <>
      <div className={cn("flex min-w-0 items-center gap-2", className)}>
        <MessageCopyButton text={copyText} />
        {sshKeyPath ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              setSshKeyUnlockError(null);
              setIsUnlockDialogOpen(true);
            }}
            title="Unlock SSH key"
          >
            <KeyRoundIcon className="size-3" />
            <span>Unlock SSH key</span>
          </Button>
        ) : null}
      </div>
      {sshKeyPath ? (
        <SidebarUnlockSshKeyDialog
          open={isUnlockDialogOpen}
          keyPath={sshKeyPath}
          description={
            <>
              BigBud needs the passphrase for <code>{sshKeyPath}</code> before it can start provider
              sessions on this remote target.
            </>
          }
          passphrase={sshKeyPassphrase}
          error={sshKeyUnlockError}
          isSubmitting={isUnlockingSshKey}
          onOpenChange={(open) => {
            if (!isUnlockingSshKey) {
              setIsUnlockDialogOpen(open);
            }
          }}
          onPassphraseChange={setSshKeyPassphrase}
          onSubmit={() => {
            void submitSshKeyUnlock();
          }}
        />
      ) : null}
    </>
  );
});

export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  executionTargetId?: ExecutionTargetId | undefined;
  showActions?: boolean;
}) {
  const { workEntry, executionTargetId, showActions = true } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const rawCommand = workEntryRawCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  return (
    <div className="group/work-entry rounded-lg px-1 py-1">
      <div className="flex items-start gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="max-w-full">
            <p
              className={cn(
                "truncate text-xs leading-5",
                workToneClass(workEntry.tone),
                preview ? "text-muted-foreground/70" : "",
              )}
              title={rawCommand ? undefined : displayText}
            >
              <span
                className={cn(
                  workEntry.tone === "thinking" || workEntry.tone === "info"
                    ? workToneClass(workEntry.tone)
                    : "text-foreground/80",
                )}
              >
                {heading}
              </span>
              {preview &&
                (rawCommand ? (
                  <Tooltip>
                    <TooltipTrigger
                      closeDelay={0}
                      delay={75}
                      render={
                        <span className="max-w-full cursor-default text-muted-foreground/55 transition-colors hover:text-muted-foreground/75 focus-visible:text-muted-foreground/75">
                          {" "}
                          - {preview}
                        </span>
                      }
                    />
                    <TooltipPopup
                      align="start"
                      className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
                      side="top"
                    >
                      <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
                        {rawCommand}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                ) : (
                  <span className="text-muted-foreground/55"> - {preview}</span>
                ))}
            </p>
          </div>
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath: string) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
              title={filePath}
            >
              {filePath}
            </span>
          ))}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
      {showActions && (
        <div className="mt-1.5 flex justify-start pl-6">
          <WorkEntryActionButtons
            workEntry={workEntry}
            executionTargetId={executionTargetId}
            className="opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/work-entry:opacity-100"
          />
        </div>
      )}
    </div>
  );
});

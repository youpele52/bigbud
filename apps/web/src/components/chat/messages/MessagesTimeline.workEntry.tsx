import { memo } from "react";
import { type ExecutionTargetId } from "@bigbud/contracts";
import {
  type TimelineWorkEntry,
  toolWorkEntryHeading,
  workEntryIcon,
  workEntryPreview,
  workEntryRawCommand,
  workToneClass,
  workToneIcon,
} from "./MessagesTimeline.workEntry.logic";
import { WorkEntryActionButtons } from "./MessagesTimeline.workEntry.actions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { attachmentPreviewRoutePath, toAttachmentPreviewUrl } from "~/lib/attachmentPreview";
import { cn } from "~/lib/utils";

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
  const attachmentUrl = workEntry.attachmentUrl
    ? toAttachmentPreviewUrl(attachmentPreviewRoutePath(workEntry.attachmentUrl))
    : null;

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
              className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 text-xs font-light text-muted-foreground/75"
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
      {attachmentUrl && (
        <div className="mt-1 pl-6">
          <a
            href={attachmentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block overflow-hidden rounded-md border border-border/55"
          >
            <img
              src={attachmentUrl}
              alt="Computer use screenshot"
              className="max-h-[160px] w-auto"
              loading="lazy"
            />
          </a>
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

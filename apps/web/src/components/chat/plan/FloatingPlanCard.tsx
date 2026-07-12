import { memo, type ReactNode, useCallback, useState } from "react";
import type { ExecutionTargetId } from "@bigbud/contracts";
import { type TimestampFormat } from "@bigbud/contracts/settings";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, EllipsisIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import type { ActivePlanState, LatestProposedPlanState } from "../../../logic/session";
import {
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../../logic/proposed-plan";
import { readNativeApi } from "../../../rpc/nativeApi";
import { formatTimestamp } from "../../../utils/timestamp";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import ChatMarkdown from "../common/ChatMarkdown";

function stepStatusIcon(status: string): ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-success/18 bg-muted/18 text-success-foreground">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span
        aria-label="Current step"
        className="inline-flex size-5 shrink-0 items-center justify-center"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-info-foreground" />
      </span>
    );
  }
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center">
      <span className="h-1.5 w-1.5 rounded-full border border-border/60 bg-transparent" />
    </span>
  );
}

interface FloatingPlanCardProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  label?: string;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  workspaceExecutionTargetId?: ExecutionTargetId | undefined;
  timestampFormat: TimestampFormat;
  onClose: () => void;
}

export const FloatingPlanCard = memo(function FloatingPlanCard({
  activePlan,
  activeProposedPlan,
  label = "Plan",
  markdownCwd,
  workspaceRoot,
  workspaceExecutionTargetId,
  timestampFormat,
  onClose,
}: FloatingPlanCardProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;
  const cardTimestamp = activePlan?.createdAt ?? activeProposedPlan?.createdAt ?? null;

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [copyToClipboard, planMarkdown]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readNativeApi();
    if (!api || !workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        ...(workspaceExecutionTargetId ? { executionTargetId: workspaceExecutionTargetId } : {}),
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save plan",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      })
      .then(
        () => setIsSavingToWorkspace(false),
        () => setIsSavingToWorkspace(false),
      );
  }, [planMarkdown, workspaceExecutionTargetId, workspaceRoot]);

  return (
    <div className="relative flex max-h-[min(28rem,calc(100dvh-15rem))] w-full flex-col overflow-hidden rounded-[24px] border border-border/80 bg-background/92 text-card-foreground shadow-[0_18px_54px_rgba(0,0,0,0.24)] supports-[backdrop-filter]:bg-background/80 supports-[backdrop-filter]:backdrop-blur-md">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-medium text-foreground/92">{label}</span>
            {cardTimestamp ? (
              <span className="truncate text-sm text-muted-foreground/55">
                {formatTimestamp(cardTimestamp, timestampFormat)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {planMarkdown ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground/50 hover:text-foreground/70"
                    aria-label="Plan actions"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={handleCopyPlan}>
                  {isCopied ? "Copied!" : "Copy to clipboard"}
                </MenuItem>
                <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
                <MenuItem
                  onClick={handleSaveToWorkspace}
                  disabled={!workspaceRoot || isSavingToWorkspace}
                >
                  Save to workspace
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label={`Close ${label.toLowerCase()} card`}
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-4 pr-2 [scrollbar-gutter:stable] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/20 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1.5 hover:[&::-webkit-scrollbar-thumb]:bg-foreground/28">
        <div className="space-y-4 pr-2">
          {activePlan?.explanation ? (
            <p className="text-[13px] leading-5 text-foreground/80">{activePlan.explanation}</p>
          ) : null}

          {activePlan && activePlan.steps.length > 0 ? (
            <div className="space-y-1.5">
              <p className="mb-2 text-sm font-medium text-foreground/90">Steps</p>
              {activePlan.steps.map((step) => (
                <div
                  key={`${step.status}:${step.step}`}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl border px-2.5 py-2.5 transition-colors duration-200",
                    step.status === "inProgress" &&
                      "border-border/45 bg-accent/18 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]",
                    step.status === "completed" &&
                      "border-success/14 bg-muted/18 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]",
                    step.status !== "inProgress" &&
                      step.status !== "completed" &&
                      "border-border/35 bg-transparent",
                  )}
                >
                  {stepStatusIcon(step.status)}
                  <p
                    className={cn(
                      "text-[13px] leading-5",
                      step.status === "completed"
                        ? "text-muted-foreground/52 line-through decoration-muted-foreground/20"
                        : step.status === "inProgress"
                          ? "font-medium text-foreground/92"
                          : "text-muted-foreground/68",
                    )}
                  >
                    {step.step}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          {planMarkdown ? (
            <div className="space-y-2">
              <button
                type="button"
                className="group flex w-full items-center gap-1.5 text-left"
                onClick={() => setProposedPlanExpanded((value) => !value)}
              >
                {proposedPlanExpanded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                )}
                <span
                  className={cn(
                    "text-sm font-medium text-foreground/90",
                    "truncate group-hover:text-muted-foreground/60",
                  )}
                >
                  {planTitle ?? "Full Plan"}
                </span>
              </button>
              {proposedPlanExpanded ? (
                <div className="rounded-xl border border-border/50 bg-muted/12 p-3">
                  <ChatMarkdown
                    text={displayedPlanMarkdown ?? ""}
                    cwd={markdownCwd}
                    isStreaming={false}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {!activePlan && !planMarkdown ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-muted-foreground/40">No active plan yet.</p>
              <p className="mt-1 text-xs text-muted-foreground/30">
                Plans will appear here when generated.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

export type { FloatingPlanCardProps };

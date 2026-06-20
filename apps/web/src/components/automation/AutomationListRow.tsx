import { type AutomationId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SquarePenIcon, Trash2Icon } from "lucide-react";
import type { MouseEvent } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatAutomationListTimeLabel } from "~/lib/automation";
import { readNativeApi } from "~/rpc/nativeApi";
import { toastManager } from "~/components/ui/toast";
import { invalidateAutomationThreadIds } from "./automationThreadIds.store";

type AutomationSummary = Awaited<
  ReturnType<NonNullable<ReturnType<typeof readNativeApi>>["server"]["listAutomations"]>
>["automations"][number];

interface AutomationListRowProps {
  readonly automation: AutomationSummary;
  readonly onAutomationsChange: () => void;
  readonly selected: boolean;
  readonly viewingAutomationId: AutomationId | null;
}

export function AutomationListRow({
  automation,
  onAutomationsChange,
  selected,
  viewingAutomationId,
}: AutomationListRowProps) {
  const api = readNativeApi();
  const navigate = useNavigate();

  const openAutomation = () => {
    void navigate({
      to: "/automations/$automationId",
      params: { automationId: automation.automationId },
    });
  };

  const handleEdit = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openAutomation();
  };

  const handleDelete = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!api) {
      return;
    }

    void (async () => {
      try {
        await api.server.deleteAutomation({ automationId: automation.automationId });
        invalidateAutomationThreadIds();
        if (viewingAutomationId === automation.automationId) {
          await navigate({ to: "/automations" });
        }
        onAutomationsChange();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to delete automation",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    })();
  };

  return (
    <div
      className={`group/automation-row flex w-full items-center justify-between gap-4 rounded-lg px-3 py-3 transition-colors ${
        selected
          ? "bg-accent/35 text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      <button type="button" className="min-w-0 flex-1 text-left" onClick={openAutomation}>
        <span className="truncate text-sm">{automation.title}</span>
      </button>

      <div className="relative flex min-w-[7.5rem] shrink-0 items-center justify-end">
        <span className="truncate text-xs text-muted-foreground transition-opacity duration-150 group-hover/automation-row:opacity-0 group-focus-within/automation-row:opacity-0">
          {formatAutomationListTimeLabel(automation)}
        </span>
        <div className="absolute inset-y-0 right-0 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/automation-row:opacity-100 group-focus-within/automation-row:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="toolbar"
                  size="icon-xs"
                  aria-label={`Edit ${automation.title}`}
                  onClick={handleEdit}
                />
              }
            >
              <SquarePenIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Edit</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="toolbar"
                  size="icon-xs"
                  disabled={!api}
                  aria-label={`Delete ${automation.title}`}
                  onClick={handleDelete}
                />
              }
            >
              <Trash2Icon />
            </TooltipTrigger>
            <TooltipPopup side="top">Delete</TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

import { type AutomationId } from "@bigbud/contracts";
import { PauseIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "~/components/ui/toast";
import { readNativeApi } from "~/rpc/nativeApi";
import { invalidateAutomationThreadIds } from "./automationThreadIds.store";

type AutomationDetail = Awaited<
  ReturnType<NonNullable<ReturnType<typeof readNativeApi>>["server"]["getAutomation"]>
>["automation"];

interface AutomationDetailActionsProps {
  readonly automation: AutomationDetail;
  readonly onReload: () => Promise<void>;
}

export function AutomationDetailActions({ automation, onReload }: AutomationDetailActionsProps) {
  const api = readNativeApi();
  const navigate = useNavigate();
  const isPaused = automation.pausedAt !== null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="toolbar"
              size="icon-xs"
              disabled={!api}
              aria-label={isPaused ? "Resume automation" : "Pause automation"}
              onClick={() => {
                if (!api) return;
                void handlePauseResume(api, automation, onReload);
              }}
            />
          }
        >
          {isPaused ? <PlayIcon /> : <PauseIcon />}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{isPaused ? "Resume" : "Pause"}</TooltipPopup>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="toolbar"
              size="icon-xs"
              disabled={!api}
              aria-label="Delete automation"
              onClick={() => {
                if (!api) return;
                void handleDelete(api, automation.automationId, navigate);
              }}
            />
          }
        >
          <Trash2Icon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Delete</TooltipPopup>
      </Tooltip>

      <Button
        type="button"
        variant="default"
        size="xs"
        disabled={!api}
        aria-label="Run automation now"
        onClick={() => {
          if (!api) return;
          void handleTrigger(api, automation, onReload, navigate);
        }}
      >
        <PlayIcon />
        Run now
      </Button>
    </>
  );
}

async function handleTrigger(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  automation: AutomationDetail,
  reload: () => Promise<void>,
  navigate: ReturnType<typeof useNavigate>,
) {
  try {
    const result = await api.server.triggerAutomation({ automationId: automation.automationId });
    if ("status" in result) {
      if (result.status === "paused_or_completed") {
        toastManager.add({
          type: "error",
          title: "Failed to run automation",
          description: "This automation has already completed.",
        });
        return;
      }
      if (result.status !== "dispatched") {
        toastManager.add({
          type: "error",
          title: "Failed to run automation",
          description:
            "The automation could not be dispatched. Check that it is active and try again.",
        });
        return;
      }
    }

    toastManager.add({
      type: "success",
      title: "Automation started",
      description: "Opening the automation thread.",
    });
    await reload();
    await navigate({ to: "/$threadId", params: { threadId: automation.targetThreadId } });
  } catch (error) {
    const description = error instanceof Error ? error.message : "An error occurred.";
    toastManager.add({
      type: "error",
      title: "Failed to run automation",
      description,
    });
  }
}

async function handlePauseResume(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  automation: AutomationDetail,
  reload: () => Promise<void>,
) {
  try {
    if (automation.pausedAt === null) {
      await api.server.pauseAutomation({ automationId: automation.automationId });
    } else {
      await api.server.resumeAutomation({ automationId: automation.automationId });
    }
    await reload();
  } catch (error) {
    const description = error instanceof Error ? error.message : "An error occurred.";
    toastManager.add({
      type: "error",
      title:
        automation.pausedAt === null ? "Failed to pause automation" : "Failed to resume automation",
      description,
    });
  }
}

async function handleDelete(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  automationId: AutomationId,
  navigate: ReturnType<typeof useNavigate>,
) {
  try {
    await api.server.deleteAutomation({ automationId });
    invalidateAutomationThreadIds();
    await navigate({ to: "/automations" });
  } catch (error) {
    const description = error instanceof Error ? error.message : "An error occurred.";
    toastManager.add({
      type: "error",
      title: "Failed to delete automation",
      description,
    });
  }
}

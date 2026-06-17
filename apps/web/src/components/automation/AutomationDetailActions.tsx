import { type AutomationId } from "@bigbud/contracts";
import { PauseIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
  await api.server.triggerAutomation({ automationId: automation.automationId });
  await reload();
  await navigate({ to: "/$threadId", params: { threadId: automation.targetThreadId } });
}

async function handlePauseResume(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  automation: AutomationDetail,
  reload: () => Promise<void>,
) {
  if (automation.pausedAt === null) {
    await api.server.pauseAutomation({ automationId: automation.automationId });
  } else {
    await api.server.resumeAutomation({ automationId: automation.automationId });
  }
  await reload();
}

async function handleDelete(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  automationId: AutomationId,
  navigate: ReturnType<typeof useNavigate>,
) {
  await api.server.deleteAutomation({ automationId });
  invalidateAutomationThreadIds();
  await navigate({ to: "/automations" });
}

import { useState } from "react";
import { SquareIcon } from "lucide-react";
import type { OrchestrationTask, ThreadId } from "@bigbud/contracts";

import { cn } from "~/lib/utils";
import { readNativeApi } from "~/rpc/nativeApi";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { isFreshActiveProviderAgent } from "./agentActivity.presentation";
import { subagentDisplayName } from "./subagentPresentation.logic";

/** Requests a per-subagent Stop (D3); the row status changes only when the provider reports it. */
export type SubagentStopHandler = (agent: OrchestrationTask) => Promise<void>;

export function makeSubagentStopHandler(threadId: ThreadId): SubagentStopHandler {
  return async (agent) => {
    const api = readNativeApi();
    if (!api || !agent.nativeId) throw new Error("Stopping this subagent is unavailable.");
    await api.server.stopSubagent({ threadId, nativeTaskId: agent.nativeId });
  };
}

/** Stop is offered only for fresh running rows that carry a provider task ID. */
export function canStopSubagent(agent: OrchestrationTask): boolean {
  return isFreshActiveProviderAgent(agent) && Boolean(agent.nativeId);
}

export function SubagentStopButton(props: {
  agent: OrchestrationTask;
  onStop: SubagentStopHandler;
  className?: string | undefined;
}) {
  const [pending, setPending] = useState(false);
  const name = subagentDisplayName(props.agent);
  const stop = async () => {
    setPending(true);
    try {
      await props.onStop(props.agent);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not stop the subagent",
        description: error instanceof Error ? error.message : "The provider rejected the request.",
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className={cn(
              "shrink-0 text-muted-foreground [:hover,[data-pressed]]:bg-red-500/10 hover:text-red-600 focus-visible:text-red-600 dark:hover:text-red-400 dark:focus-visible:text-red-400",
              props.className,
            )}
            aria-label={`Stop ${name}`}
            data-subagent-stop
            disabled={pending}
            onClick={(event) => {
              // Stop sits inside the row's details toggle; keep it from expanding the row.
              event.stopPropagation();
              void stop();
            }}
          >
            <SquareIcon aria-hidden="true" className="size-3" />
          </Button>
        }
      />
      <TooltipPopup>Stop {name}</TooltipPopup>
    </Tooltip>
  );
}

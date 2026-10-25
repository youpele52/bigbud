import { useState } from "react";

import { cn } from "../../../lib/utils";
import type { DelegatedChildSummary } from "../../../models/types/app.types";
import { Button } from "../../ui/button";
import { ThreadOriginLink } from "../messages/ThreadOriginLink";
import { ThreadModelChoicePicker } from "../view/ThreadModelChoicePicker";
import {
  useModelChoiceCountdown,
  usePickDelegatedModelChoice,
} from "../view/ThreadModelChoiceNotice.hooks";
import { deriveModelChoiceCardRow } from "../view/ThreadModelChoiceNotice.logic";

/**
 * One delegated child in the trunk's card. A pending model choice opens the same picker as the
 * tributary notice (OD3); a resolved one shows the model used, green or amber.
 */
export function DelegatedChildRow({ child }: { readonly child: DelegatedChildSummary }) {
  const record = child.modelChoice?.source === "tributary" ? child.modelChoice.record : null;
  const remainingMs = useModelChoiceCountdown(record);
  const { pick, pickingChoiceId } = usePickDelegatedModelChoice(child.threadId);
  const [open, setOpen] = useState(false);
  const row = deriveModelChoiceCardRow(child.modelChoice, remainingMs);
  const pending = row?.kind === "pending" && record?.status === "pending" ? record : null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-delegated-child={child.threadId}
    >
      <ThreadOriginLink
        threadId={child.threadId}
        title={child.title}
        available={child.workflowState !== "unavailable"}
      />
      <div className="ml-auto flex items-center gap-2">
        {row === null ? null : pending !== null ? (
          <Button
            size="xs"
            variant="outline"
            className="border-info/40 text-info"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {row.label}
          </Button>
        ) : (
          <span
            className={cn(
              "text-xs",
              row.kind === "resolved" && row.tone === "success" ? "text-success" : null,
              row.kind === "resolved" && row.tone === "warning" ? "text-warning" : null,
              row.kind !== "resolved" ? "text-muted-foreground" : null,
            )}
            title={row.kind === "resolved" ? row.title : undefined}
          >
            {row.label}
          </span>
        )}
        <span className="text-xs capitalize text-muted-foreground">{child.workflowState}</span>
      </div>
      {pending !== null && open ? (
        <div className="basis-full rounded-md border border-info/32 bg-info/4 p-2">
          <ThreadModelChoicePicker
            choice={pending}
            disabled={pickingChoiceId === pending.choiceId}
            onPick={(selection) => void pick(pending.choiceId, selection)}
          />
        </div>
      ) : null}
    </div>
  );
}

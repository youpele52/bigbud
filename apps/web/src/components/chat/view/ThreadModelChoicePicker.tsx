import type { ModelSelection } from "@bigbud/contracts";
import type { DelegationModelChoiceRequested } from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { modelSelectionKey } from "@bigbud/shared/delegatedModelChoice";
import { useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { visibleModelChoiceOptions } from "./ThreadModelChoiceNotice.logic";

/**
 * The usable models offered for a held delegated thread (shared by the tributary notice and the
 * trunk's card, OD3). Touch-friendly wrapping buttons; all disabled while a pick is in flight.
 */
export function ThreadModelChoicePicker({
  choice,
  disabled,
  onPick,
}: {
  readonly choice: Pick<DelegationModelChoiceRequested, "choiceId" | "options" | "fallback">;
  readonly disabled: boolean;
  readonly onPick: (selection: ModelSelection) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { visible, hiddenCount } = visibleModelChoiceOptions(choice.options, showAll);
  const fallback = choice.options.find((option) => option.isFallback);
  return (
    <div className="flex flex-col gap-2" data-model-choice-picker={choice.choiceId}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Available models">
        {visible.map((option) => (
          <Button
            key={modelSelectionKey(option.selection)}
            size="sm"
            variant={option.isFallback ? "secondary" : "outline"}
            className={cn(
              "h-auto min-h-8 py-1 text-sm",
              option.isFallback && "ring-1 ring-info/40",
            )}
            disabled={disabled}
            onClick={() => onPick(option.selection)}
          >
            <span>{option.label}</span>
            <span className="text-xs text-muted-foreground">
              {option.providerLabel}
              {option.isFallback ? " · parent's model" : ""}
            </span>
          </Button>
        ))}
        {hiddenCount > 0 ? (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setShowAll(true)}>
            Show all ({hiddenCount} more)
          </Button>
        ) : null}
      </div>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onPick(fallback?.selection ?? choice.fallback)}
        >
          Use {fallback?.label ?? choice.fallback.model} now
        </Button>
      </div>
    </div>
  );
}

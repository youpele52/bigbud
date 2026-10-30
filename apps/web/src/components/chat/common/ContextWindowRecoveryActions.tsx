import { Button } from "../../ui/button";

export interface ContextWindowRecoveryActionsProps {
  handoffAvailable: boolean;
  onUseHandoff: () => void;
  compactAvailable?: boolean;
  compactReason?: string;
  onCompact?: () => void;
}

export function ContextWindowRecoveryActions({
  handoffAvailable,
  onUseHandoff,
  compactAvailable,
  compactReason,
  onCompact,
}: ContextWindowRecoveryActionsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {onCompact && (
        <Button
          variant="outline"
          size="sm"
          disabled={!compactAvailable}
          title={compactReason}
          onClick={onCompact}
        >
          Compact context
        </Button>
      )}
      {handoffAvailable && (
        <Button variant="outline" size="sm" onClick={onUseHandoff}>
          Use handoff
        </Button>
      )}
    </div>
  );
}

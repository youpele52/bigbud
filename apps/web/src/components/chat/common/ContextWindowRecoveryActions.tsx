import { Button } from "../../ui/button";

export interface ContextWindowRecoveryActionsProps {
  handoffAvailable: boolean;
  compactAvailable: boolean;
  onUseHandoff: () => void;
  onCompact: () => void;
}

export function ContextWindowRecoveryActions({
  handoffAvailable,
  compactAvailable,
  onUseHandoff,
  onCompact,
}: ContextWindowRecoveryActionsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {handoffAvailable && (
        <Button variant="outline" size="sm" onClick={onUseHandoff}>
          Use handoff
        </Button>
      )}
      {compactAvailable && (
        <Button variant="outline" size="sm" onClick={onCompact}>
          Compact
        </Button>
      )}
    </div>
  );
}

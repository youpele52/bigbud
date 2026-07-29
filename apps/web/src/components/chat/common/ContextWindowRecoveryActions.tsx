import { Button } from "../../ui/button";

export interface ContextWindowRecoveryActionsProps {
  handoffAvailable: boolean;
  onUseHandoff: () => void;
}

export function ContextWindowRecoveryActions({
  handoffAvailable,
  onUseHandoff,
}: ContextWindowRecoveryActionsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {handoffAvailable && (
        <Button variant="outline" size="sm" onClick={onUseHandoff}>
          Use handoff
        </Button>
      )}
    </div>
  );
}

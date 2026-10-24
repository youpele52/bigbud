import { Button } from "../../ui/button";

export interface ActivityOverflowState {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly onToggle: () => void;
}

/** "Show N more" / "Show less" toggle shared by work logs and subagent lists. */
export function ActivityOverflowToggle(props: ActivityOverflowState & { className?: string }) {
  return (
    <Button
      size="xs"
      variant="text"
      type="button"
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      className={props.className}
    >
      {props.expanded ? "Show less" : `Show ${props.hiddenCount} more`}
    </Button>
  );
}

import { memo } from "react";
import { SplitIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export const MessageBranchButton = memo(function MessageBranchButton(props: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const { onClick, disabled = false } = props;
  const button = (
    <Button
      type="button"
      size="xs"
      variant="outline"
      aria-label="Branch thread"
      title="Branch thread"
      disabled={disabled}
      onClick={onClick}
    >
      <SplitIcon className="size-3" />
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{button}</TooltipTrigger>
      <TooltipPopup>Branch thread</TooltipPopup>
    </Tooltip>
  );
});

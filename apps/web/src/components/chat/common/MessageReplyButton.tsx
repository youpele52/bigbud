import { memo } from "react";
import { CornerUpLeftIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export const MessageReplyButton = memo(function MessageReplyButton(props: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const { onClick, disabled = false } = props;
  const button = (
    <Button
      type="button"
      size="xs"
      variant="outline"
      aria-label="Reply to message"
      title="Reply to message"
      disabled={disabled}
      onClick={onClick}
    >
      <CornerUpLeftIcon className="size-3" />
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{button}</TooltipTrigger>
      <TooltipPopup>Reply to message</TooltipPopup>
    </Tooltip>
  );
});

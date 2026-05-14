import { XIcon } from "lucide-react";

import { type ChatMessageReplyTarget } from "../../../models/types";
import { Button } from "../../ui/button";
import { MessageReplyPreview } from "../common/MessageReplyPreview";

export function ComposerReplyPreview(props: {
  replyTarget: ChatMessageReplyTarget;
  onClear: () => void;
  onOpenSource: () => void;
}) {
  const { replyTarget, onClear, onOpenSource } = props;

  return (
    <div className="mb-3 flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <MessageReplyPreview replyTarget={replyTarget} onClick={onOpenSource} />
      </div>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Clear reply target"
        title="Clear reply target"
        onClick={onClear}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}

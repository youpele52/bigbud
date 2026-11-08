import { useContext, useEffect, useState } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import { resolveFullMessageText } from "~/stores/main/messageText.store";
import type { ChatMessage } from "../../../models/types";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { MessageCopyButton } from "../common/MessageCopyButton";
import {
  formatTextSize,
  loadNextMessageTextChunk,
  TimelineThreadIdContext,
  type LoadedMessageText,
} from "./MessagesTimeline.truncatedMessage";

/**
 * "Show full message" for a message the store holds only a preview of. The full text loads one
 * bounded chunk per click into this row's own state (never the store) and renders as plain text,
 * which stays cheap for very long output where markdown would not.
 */
export function TruncatedMessageNotice(props: { readonly message: ChatMessage }) {
  const { message } = props;
  const threadId = useContext(TimelineThreadIdContext);
  const [loaded, setLoaded] = useState<LoadedMessageText | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  useEffect(() => {
    setLoaded(null);
    setStatus("idle");
  }, [message.id]);

  if (message.textTruncated !== true) return null;
  const totalLength = loaded?.textLength ?? message.textLength ?? message.text.length;
  const complete = loaded !== null && loaded.nextOffset === null;
  const loadMore = () => {
    const api = readNativeApi();
    if (!api || !threadId || status === "loading") return;
    setStatus("loading");
    loadNextMessageTextChunk({
      api: api.orchestration,
      threadId,
      messageId: message.id,
      loaded,
    }).then(
      (next) => {
        setLoaded(next);
        setStatus("idle");
      },
      () => setStatus("error"),
    );
  };

  return (
    <div className="mt-2 flex w-full flex-col gap-1.5" data-truncated-message={message.id}>
      {loaded ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-card/40 p-2 text-xs text-foreground/90">
          {loaded.text}
        </pre>
      ) : null}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {complete
            ? `Full message (${formatTextSize(totalLength)})`
            : `Showing part of a ${formatTextSize(totalLength)} message.`}
        </span>
        {complete ? null : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="text-xs"
            disabled={status === "loading" || !threadId}
            onClick={loadMore}
          >
            {status === "loading" ? <Spinner className="size-3" /> : null}
            {status === "error" ? "Retry" : loaded ? "Load more" : "Show full message"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Copies the full message: a truncated message reads its text through the chunk RPC. */
export function TimelineMessageCopyButton(props: {
  readonly message: ChatMessage;
  readonly text: string;
}) {
  const threadId = useContext(TimelineThreadIdContext);
  const { message } = props;
  const resolveText =
    message.textTruncated === true && threadId
      ? () => resolveFullMessageText(threadId, message)
      : undefined;
  return <MessageCopyButton text={props.text} resolveText={resolveText} />;
}

import { ThreadNoticeBanner } from "./ThreadNoticeBanner";

/** Hiding this explanation never unlocks a retained canonical transcript. */
export function OpencodeV2RetainedHistoryNotice({
  message,
  threadId,
}: {
  readonly message: string;
  readonly threadId: string;
}) {
  return (
    <ThreadNoticeBanner
      threadId={threadId}
      kind="retained-history"
      variant="warning"
      role="status"
      description={message}
      dismissLabel="Dismiss retained history notice"
    />
  );
}

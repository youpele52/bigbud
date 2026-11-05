import type { OrchestrationThreadActivity, ThreadId } from "@bigbud/contracts";
import { useMemo } from "react";

import { deriveThreadModelChoice } from "../../../logic/session/session.activity.modelChoice.logic";
import { ThreadNoticeBanner } from "../common/ThreadNoticeBanner";
import { ThreadModelChoicePicker } from "./ThreadModelChoicePicker";
import {
  useModelChoiceCountdown,
  usePickDelegatedModelChoice,
} from "./ThreadModelChoiceNotice.hooks";
import { deriveModelChoiceNotice } from "./ThreadModelChoiceNotice.logic";

/**
 * A delegated thread's model choice: blue picker with the countdown while the first turn is held,
 * then a persistent green or amber line with requested vs used.
 */
export function ThreadModelChoiceNotice({
  thread,
}: {
  readonly thread: {
    readonly id: ThreadId;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  };
}) {
  const record = useMemo(() => deriveThreadModelChoice(thread.activities), [thread.activities]);
  const remainingMs = useModelChoiceCountdown(record);
  const { pick, pickingChoiceId } = usePickDelegatedModelChoice(thread.id);
  if (record === null) return null;
  const notice = deriveModelChoiceNotice(record, remainingMs ?? 0);
  return (
    <ThreadNoticeBanner
      threadId={thread.id}
      kind="model-choice"
      scope={[record.choiceId]}
      variant={notice.tone === "info" ? "loading" : notice.tone}
      role="status"
      aria-live="polite"
      data-model-choice-notice={notice.kind}
      title={notice.title}
      dismissLabel="Dismiss model choice notice"
      descriptionProps={{ "aria-live": "off" }}
      description={notice.description}
      action={
        record.status === "pending" ? (
          <ThreadModelChoicePicker
            choice={record}
            disabled={pickingChoiceId === record.choiceId}
            onPick={(selection) => void pick(record.choiceId, selection)}
          />
        ) : null
      }
    />
  );
}

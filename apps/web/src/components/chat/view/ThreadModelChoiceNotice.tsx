import type { OrchestrationThreadActivity, ThreadId } from "@bigbud/contracts";
import { CircleCheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";

import { deriveThreadModelChoice } from "../../../logic/session/session.activity.modelChoice.logic";
import { ThreadNoticeBanner } from "../common/ThreadNoticeBanner";
import { ThreadModelChoicePicker } from "./ThreadModelChoicePicker";
import {
  useModelChoiceCountdown,
  usePickDelegatedModelChoice,
} from "./ThreadModelChoiceNotice.hooks";
import {
  deriveModelChoiceNotice,
  type ModelChoiceNoticeTone,
} from "./ThreadModelChoiceNotice.logic";

const NOTICE_ICONS: Record<ModelChoiceNoticeTone, typeof CircleCheckIcon> = {
  info: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
};

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
  const Icon = NOTICE_ICONS[notice.tone];
  return (
    <ThreadNoticeBanner
      threadId={thread.id}
      kind="model-choice"
      scope={[record.choiceId]}
      variant={notice.tone}
      role="status"
      aria-live="polite"
      data-model-choice-notice={notice.kind}
      icon={<Icon className={notice.tone === "info" ? "animate-spin" : undefined} aria-hidden />}
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

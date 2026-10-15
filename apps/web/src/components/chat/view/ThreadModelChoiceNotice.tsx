import type { OrchestrationThreadActivity, ThreadId } from "@bigbud/contracts";
import { CircleCheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";

import { deriveThreadModelChoice } from "../../../logic/session/session.activity.modelChoice.logic";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
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
    <div className="mx-auto w-full max-w-3xl px-3 pt-3 sm:px-5">
      <Alert
        variant={notice.tone}
        role="status"
        aria-live="polite"
        data-model-choice-notice={notice.kind}
      >
        <Icon className={notice.tone === "info" ? "animate-spin" : undefined} aria-hidden />
        <AlertTitle>{notice.title}</AlertTitle>
        {notice.description !== null ? (
          // The countdown changes every second; only the title is announced.
          <AlertDescription className="text-xs" aria-live="off">
            {notice.description}
          </AlertDescription>
        ) : null}
        {record.status === "pending" ? (
          <AlertDescription className="pt-1">
            <ThreadModelChoicePicker
              choice={record}
              disabled={pickingChoiceId === record.choiceId}
              onPick={(selection) => void pick(record.choiceId, selection)}
            />
          </AlertDescription>
        ) : null}
      </Alert>
    </div>
  );
}

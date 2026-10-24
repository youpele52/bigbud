import { ChevronDownIcon } from "lucide-react";
import type { TimestampFormat } from "@bigbud/contracts/settings";
import type { PendingUserInput } from "~/logic/session/session.logic";
import { formatShortTimestamp, formatHumanReadableDate } from "~/utils/timestamp";
import { UserInputQuestions } from "./UserInputQuestions";
import { MessageCopyButton } from "../common/MessageCopyButton";
import { formatUserInputHistoryForCopy } from "~/logic/session/session.userInputHistory.logic";

interface AnsweredUserInputProps {
  input: PendingUserInput;
  answers: Readonly<Record<string, unknown>>;
  answeredAt: string;
  timestampFormat: TimestampFormat;
}

export function AnsweredUserInput({
  input,
  answers,
  answeredAt,
  timestampFormat,
}: AnsweredUserInputProps) {
  return (
    <div className="group/user-input">
      <details className="group/answered-input border-b border-border/60 pb-2">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 py-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span>Question</span>
          <time dateTime={answeredAt} title={formatHumanReadableDate(answeredAt, "date-time")}>
            {formatShortTimestamp(answeredAt, timestampFormat)}
          </time>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-open/answered-input:rotate-0"
          />
        </summary>
        <div className="pb-2 pt-3">
          <UserInputQuestions questions={input.questions} answers={answers} />
        </div>
      </details>
      <div className="mt-1 flex items-center opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/user-input:opacity-100">
        <MessageCopyButton text={formatUserInputHistoryForCopy(input, answers)} />
      </div>
    </div>
  );
}

import type { TimestampFormat } from "@bigbud/contracts/settings";
import type { PendingUserInput } from "~/logic/session/session.logic";
import { formatShortTimestamp, formatHumanReadableDate } from "~/utils/timestamp";
import { UserInputQuestions } from "./UserInputQuestions";
import { ActivityAccordion } from "../common/ActivityAccordion";
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
      <ActivityAccordion
        title="Question"
        meta={
          <time dateTime={answeredAt} title={formatHumanReadableDate(answeredAt, "date-time")}>
            {formatShortTimestamp(answeredAt, timestampFormat)}
          </time>
        }
      >
        <UserInputQuestions questions={input.questions} answers={answers} />
      </ActivityAccordion>
      <div className="mt-1 flex items-center opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/user-input:opacity-100">
        <MessageCopyButton text={formatUserInputHistoryForCopy(input, answers)} />
      </div>
    </div>
  );
}

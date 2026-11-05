import type { PendingUserInput } from "~/logic/session/session.logic";
import { formatUserInputAnswer } from "~/logic/session/session.userInputHistory.logic";
import { UserInputFieldHint } from "./UserInputFieldHint";

interface UserInputQuestionsProps {
  questions: PendingUserInput["questions"];
  answers?: Readonly<Record<string, unknown>>;
}

const LABEL_CLASS_NAME = "mb-1 text-sm font-medium text-foreground/90";

/** Shared read-only question content for pending prompts and answered history. */
export function UserInputQuestions({ questions, answers }: UserInputQuestionsProps) {
  return (
    <div className="space-y-4">
      {questions.map((question, index) => (
        <div key={question.id} data-chat-cite-question-id={question.id}>
          {!answers && <UserInputFieldHint question={question} />}
          <div data-chat-cite-content data-chat-cite-region="prompt">
            {/* Keep DOM offsets stable when history hides the redundant heading. */}
            <p
              data-chat-cite-region="header"
              hidden={Boolean(answers) && question.header.trim().toLowerCase() === "question"}
              className={LABEL_CLASS_NAME}
            >
              {questions.length > 1 ? `${index + 1}. ` : ""}
              {question.header || question.question}
            </p>
            {question.header && question.question !== question.header && (
              <p
                data-chat-cite-region="question"
                className="mb-1.5 whitespace-pre-wrap break-words text-sm text-muted-foreground/80"
              >
                {question.question}
              </p>
            )}
            {question.options.length > 0 && (
              <ul data-chat-cite-region="options" className="space-y-1 pl-3">
                {question.options.map((option, optionIndex) => (
                  <li
                    key={`${question.id}:${option.id ?? `index:${optionIndex}`}`}
                    className="text-sm text-muted-foreground/70"
                  >
                    <span className="font-medium text-foreground/70">{option.label}</span>
                    {option.description && (
                      <span className="text-muted-foreground/55"> — {option.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {answers && (
            <div className="mt-4">
              <p className="mb-1 text-sm font-normal text-muted-foreground">Your answer</p>
              <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
                {formatUserInputAnswer(question, answers[question.id])}
              </p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

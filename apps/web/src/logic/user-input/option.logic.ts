import type {
  UserInputQuestion,
  UserInputQuestionOption,
} from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";

const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * The contract requires a description, so providers without one (Pi, Devin, Muse, OpenCode forms,
 * Cursor) repeat the label. Showing it again reads "Roads — Roads"; only a distinct one is shown.
 */
export function visibleUserInputOptionDescription(
  option: Pick<UserInputQuestionOption, "label" | "description">,
): string | null {
  const description = option.description?.trim();
  if (!description) return null;
  return normalize(description) === normalize(option.label) ? null : description;
}

const MULTIPLE_CHOICE_WORDING =
  /\ball that apply\b|\b(select|choose|pick|check|tick) all\b|\bone or more\b|\b(select|choose|pick) (multiple|several)\b|\bmultiple (choices|options|selections)\b/i;

/**
 * Codex `request_user_input` and Pi `ask_user` only ask single-choice questions, yet models still
 * write "select all that apply". Detects that mismatch so the panel can say only one pick is sent.
 */
export function singleChoiceQuestionAsksForMultiple(question: UserInputQuestion): boolean {
  if (question.multiSelect || question.field?.type === "multiselect") return false;
  if (question.options.length < 2) return false;
  return MULTIPLE_CHOICE_WORDING.test(`${question.header}\n${question.question}`);
}

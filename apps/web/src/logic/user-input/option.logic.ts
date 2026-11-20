import type { UserInputQuestionOption } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";

export { singleChoiceQuestionAsksForMultiple } from "@bigbud/shared/providerUserInput";

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

import type { ProviderUserInputAnswers } from "@bigbud/contracts";
import { Option } from "effect";

import { decodeUserInputSettlement } from "./Client.schema.ts";

/** Preserve native recorded answers, not the potentially losing command's submitted values. */
export function museRecordedUserInputAnswers(
  params: Record<string, unknown>,
): ProviderUserInputAnswers | undefined {
  const decoded = decodeUserInputSettlement(params);
  if (Option.isNone(decoded)) return undefined;
  const { answers, outcome } = decoded.value;
  if (outcome === "answered" && answers.length === 0) return undefined;
  if (["cancelled", "clarified", "timedOut", "aborted"].includes(outcome) && answers.length !== 0)
    return undefined;
  if (new Set(answers.map((answer) => answer.questionId)).size !== answers.length) return undefined;
  const entries: Array<[string, unknown]> = [];
  for (const answer of answers) {
    const forms = [answer.selectedLabel, answer.selectedLabels, answer.freeText].filter(
      (value) => value !== undefined,
    );
    if (forms.length !== 1) return undefined;
    // Canonical answers are arbitrary values: retain the native structured
    // entry when it carries a note, rather than silently discarding that text.
    const value = answer.note !== undefined ? { ...answer } : forms[0];
    entries.push([answer.questionId, value]);
  }
  return Object.fromEntries(entries);
}

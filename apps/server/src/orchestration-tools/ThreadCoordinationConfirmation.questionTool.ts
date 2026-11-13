/**
 * The question tool each provider's model sees, so a cross-project confirmation can name it
 * exactly instead of offering a generic "if you have no question tool" escape. Live testing
 * (2026-11-13) showed Codex in Default mode taking that escape into a plain chat question while
 * `request_user_input` was available. Only names verified in bigbud's adapters or live runs are
 * listed; any other provider keeps the generic wording.
 *
 * @module ThreadCoordinationConfirmation.questionTool
 */
import type { ProviderKind } from "@bigbud/contracts";

export interface ThreadCoordinationQuestionTool {
  readonly name: string;
  /**
   * The tool can be absent from a session that uses this provider: Codex offers
   * `request_user_input` in Default mode only on CLI 0.167.0+ (`codex/codexQuestionTool.ts`), and
   * the server cannot see the CLI version here, so the model checks its own tool list.
   */
  readonly mayBeMissing: boolean;
}

const QUESTION_TOOLS: Partial<Record<ProviderKind, ThreadCoordinationQuestionTool>> = {
  claudeAgent: { name: "AskUserQuestion", mayBeMissing: false },
  codex: { name: "request_user_input", mayBeMissing: true },
  devin: { name: "ask_user_question", mayBeMissing: false },
  opencode: { name: "question", mayBeMissing: false },
  opencodeV2: { name: "question", mayBeMissing: false },
  pi: { name: "ask_user", mayBeMissing: false },
};

/** The calling thread's question tool, or undefined when its provider is unknown or unlisted. */
export function threadCoordinationQuestionTool(
  providerName: string | null | undefined,
): ThreadCoordinationQuestionTool | undefined {
  if (!providerName || !Object.hasOwn(QUESTION_TOOLS, providerName)) return undefined;
  return QUESTION_TOOLS[providerName as ProviderKind];
}

/**
 * Structured, success-path tool results for a cross-project write that still needs (or was
 * refused) the user's confirmation. Every bridge prints them as JSON, so they self-describe.
 *
 * @module ThreadCoordinationConfirmation.result
 */
import type { ProjectId } from "@bigbud/contracts";

import type { ThreadCoordinationChallenge } from "./Services/ThreadCoordinationGrants.ts";
import type { ThreadCoordinationQuestionTool } from "./ThreadCoordinationConfirmation.questionTool.ts";

export const THREAD_COORDINATION_ALLOW_LABEL = "Allow";
export const THREAD_COORDINATION_DENY_LABEL = "Deny";

export interface ThreadCoordinationConfirmationRequired {
  readonly status: "confirmation_required";
  readonly code: string;
  readonly targetProjectId: ProjectId;
  readonly targetProjectTitle: string;
  readonly targetIsRemote: boolean;
  readonly question: string;
  readonly allowLabel: typeof THREAD_COORDINATION_ALLOW_LABEL;
  readonly denyLabel: typeof THREAD_COORDINATION_DENY_LABEL;
  readonly instructions: string;
}

export interface ThreadCoordinationConfirmationDenied {
  readonly status: "confirmation_denied";
  readonly targetProjectId: ProjectId;
  readonly targetProjectTitle: string;
  readonly instructions: string;
}

export type ThreadCoordinationRefusal =
  | ThreadCoordinationConfirmationRequired
  | ThreadCoordinationConfirmationDenied;

/**
 * Server-prescribed question. The code stays in the text because a card answer is matched by it;
 * it is shown as a reference, never as something the user must type.
 */
export function threadCoordinationQuestion(input: {
  readonly code: string;
  readonly projectTitle: string;
  readonly targetIsRemote: boolean;
}): string {
  return `Allow this thread to create, message, rename and organize threads in project ${JSON.stringify(input.projectTitle)}${input.targetIsRemote ? " (remote)" : ""} until bigbud restarts? (Reference: ${input.code})`;
}

const CONFIRMATION_INSTRUCTIONS = [
  "This thread needs the user's permission before it can change threads in that project.",
  "Ask about this project on its own, showing exactly the `question` text, which names the project.",
  `Use your question tool (for example AskUserQuestion, request_user_input, ask_user or ask_user_question), which bigbud shows in its question panel: one single-choice question with exactly the \`question\` text and the options "${THREAD_COORDINATION_ALLOW_LABEL}" and "${THREAD_COORDINATION_DENY_LABEL}".`,
  "Do not ask in plain chat text or through render_html while you have a question tool.",
  "If you have no question tool, show the `question` text and ask the user in chat to reply yes or no.",
  "Never ask the user to type the code; it is only a reference.",
  "After the user answers, retry the same call with the same arguments.",
  "If a retry still returns confirmation_required after the user answered (for example, in a provider's own prompt), ask them to reply yes or no in chat, then retry.",
  "Never answer on the user's behalf.",
].join(" ");

/**
 * For a caller whose question tool is known: the tool is named and is the next step, with no
 * generic chat escape. A chat fallback remains only where the tool can be absent (old Codex).
 */
function namedToolInstructions(tool: ThreadCoordinationQuestionTool): string {
  return [
    "This thread needs the user's permission before it can change threads in that project.",
    `Your next step is to call \`${tool.name}\` with one single-choice question: exactly the \`question\` text, which names the project, and the options "${THREAD_COORDINATION_ALLOW_LABEL}" and "${THREAD_COORDINATION_DENY_LABEL}". bigbud shows it in its question panel.`,
    "Do not ask in chat text or through render_html, and do not assume the answer.",
    `Writing the question or an Allow/Deny list in a message does not ask the user; only the \`${tool.name}\` call does.`,
    ...(tool.mayBeMissing
      ? [
          `Only if \`${tool.name}\` is not in your tool list, show the \`question\` text and ask the user in chat to reply yes or no.`,
        ]
      : []),
    "Never ask the user to type the code; it is only a reference.",
    "After the user answers, retry the same call with the same arguments.",
    "If a retry still returns confirmation_required after the user answered, ask them to reply yes or no in chat, then retry.",
    "Never answer on the user's behalf.",
  ].join(" ");
}

const UNAVAILABLE_INSTRUCTIONS =
  "Cross-project confirmation is unavailable on this server right now, so this change cannot be made. Tell the user; do not ask them to confirm or retry.";

export function confirmationRequiredResult(
  challenge: Pick<
    ThreadCoordinationChallenge,
    "code" | "projectId" | "projectTitle" | "targetIsRemote"
  >,
  options: {
    readonly unavailable?: boolean;
    /** The caller's question tool, when known; otherwise the generic wording is used. */
    readonly questionTool?: ThreadCoordinationQuestionTool | undefined;
  } = {},
): ThreadCoordinationConfirmationRequired {
  return {
    status: "confirmation_required",
    code: challenge.code,
    targetProjectId: challenge.projectId,
    targetProjectTitle: challenge.projectTitle,
    targetIsRemote: challenge.targetIsRemote,
    question: threadCoordinationQuestion(challenge),
    allowLabel: THREAD_COORDINATION_ALLOW_LABEL,
    denyLabel: THREAD_COORDINATION_DENY_LABEL,
    instructions: options.unavailable
      ? UNAVAILABLE_INSTRUCTIONS
      : options.questionTool
        ? namedToolInstructions(options.questionTool)
        : CONFIRMATION_INSTRUCTIONS,
  };
}

export function confirmationDeniedResult(
  challenge: Pick<ThreadCoordinationChallenge, "projectId" | "projectTitle">,
): ThreadCoordinationConfirmationDenied {
  return {
    status: "confirmation_denied",
    targetProjectId: challenge.projectId,
    targetProjectTitle: challenge.projectTitle,
    instructions:
      "The user denied this change. Do not make it, and do not ask about it again unless the user brings it up. A different, later request may ask again.",
  };
}

export function isThreadCoordinationRefusal(value: unknown): value is ThreadCoordinationRefusal {
  if (typeof value !== "object" || value === null) return false;
  const status = (value as { readonly status?: unknown }).status;
  return status === "confirmation_required" || status === "confirmation_denied";
}

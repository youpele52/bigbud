import {
  ApprovalRequestId,
  MessageId,
  type ServerProvider,
  type UserInputQuestion,
} from "@bigbud/contracts";
import type { WorkLogEntry } from "@bigbud/shared/workLog";

// Disposable data only: these fixtures never represent an installed/authenticated provider.
export const parityApproval = {
  requestId: ApprovalRequestId.makeUnsafe("parity-approval"),
  requestKind: "command" as const,
  createdAt: "2026-11-15T00:00:00.000Z",
  detail: "printf 'fixture only'",
};
export const parityQuestions: ReadonlyArray<UserInputQuestion> = [
  {
    id: "branch",
    header: "Branch",
    question: "Which branch should be used?",
    multiSelect: false,
    options: [
      { label: "main", description: "Keep the current branch" },
      { label: "feature", description: "Use a new feature branch" },
    ],
  },
];
export const parityQuestion = {
  requestId: ApprovalRequestId.makeUnsafe("parity-question"),
  createdAt: parityApproval.createdAt,
  questions: parityQuestions,
};
export const parityWorkLog: ReadonlyArray<WorkLogEntry> = [
  {
    id: "parity-tool",
    createdAt: parityApproval.createdAt,
    label: "Tool completed",
    tone: "tool",
    itemType: "command_execution",
    command: parityApproval.detail,
  },
];
export const parityMarkdown =
  "The **mobile client** keeps your draft while reconnecting.\n\n- Review the proposed change\n- Approve only when ready\n\n```ts\nconst ready = true;\n```";
export const parityMessage = {
  id: MessageId.makeUnsafe("parity-message"),
  role: "assistant" as const,
  text: parityMarkdown,
  streaming: false,
  turnId: null,
  createdAt: parityApproval.createdAt,
  updatedAt: parityApproval.createdAt,
};
export const parityProviders: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "fixture",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: parityApproval.createdAt,
    models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
];

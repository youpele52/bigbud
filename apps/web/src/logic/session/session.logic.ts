import {
  ApprovalRequestId,
  type OrchestrationLatestTurn,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";

import type { ChatMessage, ProposedPlan, ThreadSession } from "../../models/types";

export type { WorkLogEntry } from "./worklog.logic";
export { deriveWorkLogEntries } from "./worklog.logic";

// ── Re-exports from sub-modules ───────────────────────────────────────

export {
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveActivePlanState,
  compareActivitiesByOrder,
} from "./session.activity.logic";

export {
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  deriveTimelineEntries,
  deriveCompletionDividerBeforeEntryId,
  inferCheckpointTurnCountByTurnId,
  derivePhase,
} from "./session.timeline.logic";

// ── Types ─────────────────────────────────────────────────────────────

export type ProviderPickerKind = ProviderKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeAgent", label: "Claude", available: true },
  { value: "copilot", label: "Copilot", available: true },
  { value: "opencode", label: "OpenCode", available: true },
  { value: "pi", label: "Pi", available: true },
  { value: "cursor", label: "Cursor", available: true },
];

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change" | "tool";
  createdAt: string;
  detail?: string;
  autoApproveAfterMs?: number;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: import("./worklog.logic").WorkLogEntry;
    }
  | {
      id: string;
      kind: "user-input-question";
      createdAt: string;
      pendingUserInput: PendingUserInput;
    };

// ── Format utilities ──────────────────────────────────────────────────

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

// ── Turn/session state helpers ────────────────────────────────────────

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

/** Returns true if the session is actively running the given turn (or any turn if no activeTurnId). */
export function isSessionActivelyRunningTurn(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!session || session.orchestrationStatus !== "running") return false;
  if (!latestTurn) return true;

  const activeTurnId = session.activeTurnId;
  if (activeTurnId === undefined) {
    return latestTurn.completedAt === null;
  }
  if (latestTurn.turnId !== activeTurnId) {
    return true;
  }
  return latestTurn.completedAt === null;
}

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  return !isSessionActivelyRunningTurn(latestTurn, session);
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

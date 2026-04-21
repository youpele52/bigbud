import {
  type ProjectEntry,
  type ServerDiscoveredAgent,
  type ServerDiscoveredSkill,
  type ServerProvider,
  type ThreadId,
  OrchestrationThreadActivity,
} from "@bigbud/contracts";

import { type PendingUserInputDraftAnswer } from "../../../../logic/user-input";

export const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
export const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
export const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
export const EMPTY_PROVIDERS: ServerProvider[] = [];
export const EMPTY_DISCOVERED_AGENTS: ServerDiscoveredAgent[] = [];
export const EMPTY_DISCOVERED_SKILLS: ServerDiscoveredSkill[] = [];
export const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};

export interface ChatViewProps {
  threadId: ThreadId;
}

export interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

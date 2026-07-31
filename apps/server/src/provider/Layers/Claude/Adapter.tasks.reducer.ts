import { isTaskFreshnessNewer, type TaskFreshness } from "@bigbud/shared/providerRuntime";

import { rememberBoundedIdentity } from "./Adapter.dedup.ts";
import {
  asRecord,
  fieldString,
  normalizeStatus,
  stringValue,
  stringValues,
  taskId,
  taskRecords,
  taskSubject,
} from "./Adapter.tasks.reducer.parse.ts";
import type { ClaudeTask, ClaudeTaskReduction, ClaudeTaskState } from "./Adapter.tasks.types.ts";

const TASK_DEDUP_LIMIT = 1_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "killed", "stopped"]);
const SOURCE_PRIORITY = { observed: 1, background: 2, taskList: 3, lifecycle: 4 } as const;

type Membership = "taskListMember" | "backgroundMember" | "legacyMember" | "observedMember";
type TaskSource = keyof typeof SOURCE_PRIORITY;

function isTerminal(task: ClaudeTask): boolean {
  return (
    TERMINAL_STATUSES.has(task.nativeStatus ?? "") ||
    ["completed", "failed", "stopped"].includes(task.status)
  );
}

function hasMembership(task: ClaudeTask): boolean {
  return task.taskListMember || task.backgroundMember || task.observedMember;
}

function sameTask(left: ClaudeTask | undefined, right: ClaudeTask): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function freshness(input: {
  state: ClaudeTaskState;
  source: TaskSource;
  ordinal: number;
  record: Record<string, unknown>;
  snapshotGeneration?: number | undefined;
}): TaskFreshness {
  return {
    sessionEpoch: input.state.sessionEpoch,
    sourcePriority: SOURCE_PRIORITY[input.source],
    ...(input.snapshotGeneration === undefined
      ? {}
      : { snapshotGeneration: input.snapshotGeneration }),
    ...(typeof input.record.revision === "number" || typeof input.record.revision === "string"
      ? { providerRevision: input.record.revision }
      : {}),
    ...(fieldString(input.record, "uuid", "message_id", "messageId")
      ? { providerMessageId: fieldString(input.record, "uuid", "message_id", "messageId") }
      : {}),
    ...(fieldString(input.record, "timestamp", "created_at", "createdAt")
      ? { providerTimestamp: fieldString(input.record, "timestamp", "created_at", "createdAt") }
      : {}),
    observedOrdinal: input.ordinal,
  };
}

interface ReductionContext {
  readonly state: ClaudeTaskState;
  readonly toolUseId: string;
  readonly value: Record<string, unknown>;
  readonly updatedAt: string;
  readonly ordinal: number;
  readonly source: TaskSource;
  readonly snapshotGeneration?: number;
  readonly turnId?: string;
  readonly changed: Set<string>;
  readonly removed: Set<string>;
}

function updateRecord(input: {
  readonly context: ReductionContext;
  readonly record: Record<string, unknown>;
  readonly memberships?: Partial<Pick<ClaudeTask, Membership>>;
  readonly preserveTerminal?: boolean;
}): string | undefined {
  const { context, record } = input;
  const durableId = taskId(record);
  const provisionalId = `tool:${context.toolUseId}`;
  const key = durableId ?? provisionalId;
  const provisional = context.state.tasks.get(provisionalId);
  const existing = context.state.tasks.get(key) ?? provisional;
  const nextFreshness = freshness({
    state: context.state,
    source: context.source,
    ordinal: context.ordinal,
    record: {
      ...record,
      timestamp: fieldString(record, "timestamp", "created_at", "createdAt") ?? context.updatedAt,
    },
    snapshotGeneration: context.snapshotGeneration,
  });
  if (existing && !isTaskFreshnessNewer(nextFreshness, existing.freshness)) return undefined;

  const status = normalizeStatus(record.status);
  const subject = taskSubject(record);
  // Status-only records can update a task we already know, but they do not
  // carry enough information to create a distinct visible task. CLIProxy can
  // emit these while completing a TodoWrite snapshot. Legacy TodoWrite entries
  // retain the default label for blank content.
  if (!existing && !subject && !input.memberships?.legacyMember) return undefined;
  const preserveTerminal =
    existing &&
    isTerminal(existing) &&
    status !== undefined &&
    !TERMINAL_STATUSES.has(status.nativeStatus);
  const nativeStatus = preserveTerminal
    ? existing.nativeStatus
    : (status?.nativeStatus ?? existing?.nativeStatus);
  const next: ClaudeTask = {
    id: durableId ?? existing?.id ?? provisionalId,
    sourceToolUseId: existing?.sourceToolUseId ?? context.toolUseId,
    subject: subject ?? existing?.subject ?? "Task",
    ...((stringValue(record.description) ?? existing?.description)
      ? { description: stringValue(record.description) ?? existing?.description }
      : {}),
    status: preserveTerminal ? existing.status : (status?.status ?? existing?.status ?? "pending"),
    ...(nativeStatus ? { nativeStatus } : {}),
    ...((fieldString(record, "active_form", "activeForm", "activeLabel") ?? existing?.activeLabel)
      ? {
          activeLabel:
            fieldString(record, "active_form", "activeForm", "activeLabel") ??
            existing?.activeLabel,
        }
      : {}),
    ...((fieldString(record, "request_id", "requestId") ?? existing?.requestId)
      ? { requestId: fieldString(record, "request_id", "requestId") ?? existing?.requestId }
      : {}),
    ...((fieldString(record, "agent_id", "agentId") ?? existing?.agentId)
      ? { agentId: fieldString(record, "agent_id", "agentId") ?? existing?.agentId }
      : {}),
    ...((fieldString(record, "parent_agent_id", "parentAgentId") ?? existing?.parentAgentId)
      ? {
          parentAgentId:
            fieldString(record, "parent_agent_id", "parentAgentId") ?? existing?.parentAgentId,
        }
      : {}),
    ...((fieldString(record, "parent_tool_use_id", "parentToolUseId") ?? existing?.parentToolUseId)
      ? {
          parentToolUseId:
            fieldString(record, "parent_tool_use_id", "parentToolUseId") ??
            existing?.parentToolUseId,
        }
      : {}),
    ...((fieldString(record, "parent_task_id", "parentTaskId") ?? existing?.parentTaskId)
      ? {
          parentTaskId:
            fieldString(record, "parent_task_id", "parentTaskId") ?? existing?.parentTaskId,
        }
      : {}),
    ...((fieldString(record, "subagent_type", "subagentType", "task_type") ??
    existing?.subagentType)
      ? {
          subagentType:
            fieldString(record, "subagent_type", "subagentType", "task_type") ??
            existing?.subagentType,
        }
      : {}),
    ...((stringValues(record.blocks) ?? existing?.blocks)
      ? { blocks: stringValues(record.blocks) ?? existing?.blocks }
      : {}),
    ...((stringValues(record.blockedBy) ?? stringValues(record.blocked_by) ?? existing?.blockedBy)
      ? {
          blockedBy:
            stringValues(record.blockedBy) ??
            stringValues(record.blocked_by) ??
            existing?.blockedBy,
        }
      : {}),
    ...((fieldString(record, "progress_summary", "progressSummary", "summary") ??
    existing?.progressSummary)
      ? {
          progressSummary:
            fieldString(record, "progress_summary", "progressSummary", "summary") ??
            existing?.progressSummary,
        }
      : {}),
    ...((fieldString(record, "last_tool_name", "lastToolName") ?? existing?.lastToolName)
      ? {
          lastToolName:
            fieldString(record, "last_tool_name", "lastToolName") ?? existing?.lastToolName,
        }
      : {}),
    ...(record.usage !== undefined
      ? { usage: record.usage }
      : existing?.usage !== undefined
        ? { usage: existing.usage }
        : {}),
    ...((fieldString(record, "terminal_reason", "terminalReason", "error") ??
    existing?.terminalReason)
      ? {
          terminalReason:
            fieldString(record, "terminal_reason", "terminalReason", "error") ??
            existing?.terminalReason,
        }
      : {}),
    ...(context.turnId
      ? { turnId: context.turnId }
      : existing?.turnId
        ? { turnId: existing.turnId }
        : {}),
    order: existing?.order ?? context.state.nextOrder++,
    membership: {
      taskList: input.memberships?.taskListMember ?? existing?.taskListMember ?? false,
      background: input.memberships?.backgroundMember ?? existing?.backgroundMember ?? false,
      observed: input.memberships?.observedMember ?? existing?.observedMember ?? false,
      legacy: input.memberships?.legacyMember ?? existing?.legacyMember ?? false,
    },
    taskListMember: input.memberships?.taskListMember ?? existing?.taskListMember ?? false,
    backgroundMember: input.memberships?.backgroundMember ?? existing?.backgroundMember ?? false,
    legacyMember: input.memberships?.legacyMember ?? existing?.legacyMember ?? false,
    observedMember: input.memberships?.observedMember ?? existing?.observedMember ?? false,
    lastObservedOrdinal: context.ordinal,
    freshness: nextFreshness,
    updatedAt: context.updatedAt,
  };
  if (provisional && durableId && provisionalId !== durableId)
    context.state.tasks.delete(provisionalId);
  if (sameTask(existing, next) && !(provisional && durableId)) return undefined;
  context.state.tasks.set(key, next);
  return key;
}

function applySnapshotMembership(
  input: ReductionContext & { member: Membership; nextIds: ReadonlySet<string> },
) {
  for (const [key, task] of input.state.tasks) {
    if (!task[input.member] || input.nextIds.has(key)) continue;
    const next = {
      ...task,
      [input.member]: false,
      lastObservedOrdinal: input.ordinal,
      updatedAt: input.updatedAt,
    };
    if (!hasMembership(next)) {
      input.state.tasks.delete(key);
      input.removed.add(key);
    } else {
      input.state.tasks.set(key, next);
      input.changed.add(key);
    }
  }
}

function reduceSnapshot(
  input: ReductionContext,
  member: Membership,
  records: ReadonlyArray<Record<string, unknown>>,
) {
  const nextIds = new Set<string>();
  for (const [index, record] of records.entries()) {
    const id = taskId(record) ?? (member === "legacyMember" ? `todo:${index}` : undefined);
    if (!id) continue;
    nextIds.add(id);
    const changed = updateRecord({
      context: input,
      record: id === taskId(record) ? record : { ...record, id },
      memberships: { [member]: true },
    });
    if (changed) input.changed.add(changed);
  }
  applySnapshotMembership({ ...input, member, nextIds });
}

export function reduceClaudeTaskState(input: {
  readonly state: ClaudeTaskState;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly value: Record<string, unknown>;
  readonly updatedAt: string;
  readonly authoritativeSnapshot?: boolean;
  readonly turnId?: string;
}): ClaudeTaskReduction {
  const messageId = stringValue(input.value.uuid);
  if (
    messageId &&
    !rememberBoundedIdentity(input.state.seenMessageIds, messageId, TASK_DEDUP_LIMIT)
  ) {
    return { changedTaskIds: [], removedTaskIds: [], changed: false };
  }
  const inputFingerprint = `${input.toolName}:${input.toolUseId}:${JSON.stringify(input.value)}`;
  if (
    !rememberBoundedIdentity(input.state.seenInputFingerprints, inputFingerprint, TASK_DEDUP_LIMIT)
  ) {
    return { changedTaskIds: [], removedTaskIds: [], changed: false };
  }

  const isTaskList = input.toolName === "TaskList" && input.authoritativeSnapshot === true;
  const isBackground = input.toolName === "background_tasks_changed";
  const snapshotSource = isTaskList
    ? "taskList"
    : isBackground
      ? "background"
      : input.toolName === "TodoWrite"
        ? "legacy"
        : undefined;
  const snapshotRecords = snapshotSource ? taskRecords(input.value) : [];
  const snapshotFingerprint = snapshotSource ? JSON.stringify(snapshotRecords) : undefined;
  if (
    snapshotSource &&
    snapshotFingerprint === input.state.snapshotFingerprints.get(snapshotSource)
  ) {
    return { changedTaskIds: [], removedTaskIds: [], changed: false };
  }
  const snapshotFreshness = snapshotSource
    ? freshness({
        state: input.state,
        source:
          snapshotSource === "taskList"
            ? "taskList"
            : snapshotSource === "background"
              ? "background"
              : "observed",
        ordinal: input.state.nextObservedOrdinal,
        record: {
          ...input.value,
          uuid: fieldString(input.value, "uuid", "message_id", "messageId") ?? input.toolUseId,
          timestamp:
            fieldString(input.value, "timestamp", "created_at", "createdAt") ?? input.updatedAt,
        },
        snapshotGeneration:
          snapshotSource === "taskList"
            ? input.state.taskListGeneration + 1
            : snapshotSource === "background"
              ? input.state.backgroundGeneration + 1
              : undefined,
      })
    : undefined;
  if (snapshotSource && snapshotFreshness) {
    const previousFreshness = input.state.snapshotFreshness.get(snapshotSource);
    if (previousFreshness && !isTaskFreshnessNewer(snapshotFreshness, previousFreshness)) {
      return { changedTaskIds: [], removedTaskIds: [], changed: false };
    }
    input.state.snapshotFingerprints.set(snapshotSource, snapshotFingerprint ?? "");
    input.state.snapshotFreshness.set(snapshotSource, snapshotFreshness);
  }

  const context: ReductionContext = {
    state: input.state,
    toolUseId: input.toolUseId,
    value: input.value,
    updatedAt: input.updatedAt,
    ordinal: input.state.nextObservedOrdinal++,
    source: isTaskList ? "taskList" : isBackground ? "background" : "observed",
    ...(isTaskList ? { snapshotGeneration: ++input.state.taskListGeneration } : {}),
    ...(isBackground ? { snapshotGeneration: ++input.state.backgroundGeneration } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    changed: new Set(),
    removed: new Set(),
  };
  if (input.toolName === "TodoWrite") {
    const todos = Array.isArray(input.value.todos)
      ? input.value.todos.flatMap((todo) => (asRecord(todo) ? [asRecord(todo)!] : []))
      : [];
    reduceSnapshot(context, "legacyMember", todos);
  } else if (isTaskList) {
    reduceSnapshot(context, "taskListMember", taskRecords(input.value));
  } else if (isBackground) {
    reduceSnapshot(context, "backgroundMember", taskRecords(input.value));
  } else {
    for (const record of taskRecords(input.value)) {
      const changed = updateRecord({
        context,
        record,
        memberships: { observedMember: true },
      });
      if (changed) context.changed.add(changed);
    }
  }
  return {
    changedTaskIds: [...context.changed],
    removedTaskIds: [...context.removed],
    changed: context.changed.size > 0 || context.removed.size > 0 || snapshotSource !== undefined,
  };
}

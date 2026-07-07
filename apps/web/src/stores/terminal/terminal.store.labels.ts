import { type ThreadId } from "@bigbud/contracts";

export function setTerminalLabelOverrideByThreadId(
  overridesByThreadId: Record<ThreadId, Record<string, string>>,
  threadId: ThreadId,
  terminalId: string,
  label: string,
): Record<ThreadId, Record<string, string>> | null {
  const trimmedLabel = label.trim();
  if (trimmedLabel.length === 0) {
    return null;
  }
  const current = overridesByThreadId[threadId] ?? {};
  if (current[terminalId] === trimmedLabel) {
    return null;
  }
  return {
    ...overridesByThreadId,
    [threadId]: {
      ...current,
      [terminalId]: trimmedLabel,
    },
  };
}

export function clearTerminalLabelOverrideByThreadId(
  overridesByThreadId: Record<ThreadId, Record<string, string>>,
  threadId: ThreadId,
  terminalId: string,
): Record<ThreadId, Record<string, string>> | null {
  const current = overridesByThreadId[threadId];
  if (!current || current[terminalId] === undefined) {
    return null;
  }
  const nextThreadOverrides = { ...current };
  delete nextThreadOverrides[terminalId];
  const nextOverrides = { ...overridesByThreadId };
  if (Object.keys(nextThreadOverrides).length === 0) {
    delete nextOverrides[threadId];
  } else {
    nextOverrides[threadId] = nextThreadOverrides;
  }
  return nextOverrides;
}

export function removeTerminalLabelOverridesForThread(
  overridesByThreadId: Record<ThreadId, Record<string, string>>,
  threadId: ThreadId,
): Record<ThreadId, Record<string, string>> {
  const nextOverrides = { ...overridesByThreadId };
  delete nextOverrides[threadId];
  return nextOverrides;
}

export function removeOrphanedTerminalLabelOverrides(
  overridesByThreadId: Record<ThreadId, Record<string, string>>,
  activeThreadIds: Set<ThreadId>,
): {
  orphanedThreadIds: ThreadId[];
  nextOverridesByThreadId: Record<ThreadId, Record<string, string>>;
} {
  const orphanedThreadIds = Object.keys(overridesByThreadId).filter(
    (id) => !activeThreadIds.has(id as ThreadId),
  ) as ThreadId[];
  if (orphanedThreadIds.length === 0) {
    return { orphanedThreadIds, nextOverridesByThreadId: overridesByThreadId };
  }
  const nextOverridesByThreadId = { ...overridesByThreadId };
  for (const threadId of orphanedThreadIds) {
    delete nextOverridesByThreadId[threadId];
  }
  return { orphanedThreadIds, nextOverridesByThreadId };
}

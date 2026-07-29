import type { OrchestrationTaskStatus } from "@bigbud/contracts";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function stringValues(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap((entry) => {
    const string = stringValue(entry);
    return string ? [string] : [];
  });
  return values.length > 0 ? values : undefined;
}

export function fieldString(input: Record<string, unknown>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = stringValue(input[key]);
    if (value) return value;
  }
  return undefined;
}

export function taskId(input: Record<string, unknown>) {
  return stringValue(input.task_id) ?? stringValue(input.taskId) ?? stringValue(input.id);
}

export function taskSubject(input: Record<string, unknown>) {
  return (
    stringValue(input.subject) ??
    stringValue(input.content) ??
    stringValue(input.description) ??
    stringValue(input.title)
  );
}

export function normalizeStatus(
  value: unknown,
): { status: OrchestrationTaskStatus; nativeStatus: string } | undefined {
  const nativeStatus = stringValue(value)?.toLowerCase().replaceAll("_", "-");
  if (!nativeStatus) return undefined;
  if (["pending", "queued", "not-started", "paused"].includes(nativeStatus)) {
    return { status: "pending", nativeStatus };
  }
  if (["running", "in-progress"].includes(nativeStatus)) {
    return { status: "inProgress", nativeStatus };
  }
  if (nativeStatus === "completed") return { status: "completed", nativeStatus };
  if (["failed", "error"].includes(nativeStatus)) return { status: "failed", nativeStatus };
  if (["cancelled", "killed", "stopped", "interrupted"].includes(nativeStatus)) {
    return { status: "stopped", nativeStatus };
  }
  return { status: "pending", nativeStatus };
}

export function taskRecords(
  input: Record<string, unknown>,
): ReadonlyArray<Record<string, unknown>> {
  const nestedTask = asRecord(input.task);
  const patch = asRecord(input.patch);
  const statusChange = asRecord(input.statusChange);
  const tasks = Array.isArray(input.tasks)
    ? input.tasks.flatMap((task) => {
        const record = asRecord(task);
        return record ? [record] : [];
      })
    : [];
  if (nestedTask) return [nestedTask, ...tasks];
  if (tasks.length > 0) return tasks;
  if (patch) return [{ ...input, ...patch }];
  if (statusChange) return [{ ...input, status: statusChange.to }];
  return [input];
}

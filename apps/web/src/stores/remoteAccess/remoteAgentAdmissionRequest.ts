import { backendScopedLocalStorage as storage } from "../../lib/backendScopedStorage";

const STORAGE_PREFIX = "bigbud:remote-agent-admission-request:v1:";
const memory = new Map<string, string>();

function storageKey(executionTargetId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(executionTargetId)}`;
}

function readStored(key: string): string | null {
  try {
    return (globalThis.window ? storage.getItem(key) : null) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeStored(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (!globalThis.window) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Private browsing and quota failures retain the in-process identity.
  }
}

/** Keep the same logical admission ID while a fresh request may still be unresolved. */
export function getRemoteAgentAdmissionRequestId(executionTargetId: string): string {
  const key = storageKey(executionTargetId);
  const existing = readStored(key);
  if (existing && /^[A-Za-z0-9-]{1,64}$/.test(existing)) return existing;
  const requestId = crypto.randomUUID();
  writeStored(key, requestId);
  return requestId;
}

export function readRemoteAgentAdmissionRequestId(executionTargetId: string): string | undefined {
  const value = readStored(storageKey(executionTargetId));
  return value && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : undefined;
}

/** Remove identity only after a success reply was received and durably selected. */
export function completeRemoteAgentAdmission(executionTargetId: string, requestId: string): void {
  const key = storageKey(executionTargetId);
  if (readStored(key) === requestId) writeStored(key, null);
}

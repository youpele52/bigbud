import type { ProjectId } from "@bigbud/contracts";
import { backendScopedLocalStorage as storage } from "../../lib/backendScopedStorage";

export interface PersistedReconnectRequest {
  readonly requestId: string;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly expectedWorkspaceExecutionTargetId: string;
}

const STORAGE_KEY = "bigbud:remote-reconnect-requests";

function readRequests(): PersistedReconnectRequest[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? (value as PersistedReconnectRequest[]) : [];
  } catch {
    return [];
  }
}

function writeRequests(requests: PersistedReconnectRequest[]) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(requests));
  } catch {
    // Reconciliation remains best-effort when storage is unavailable.
  }
}

export function saveReconnectRequest(request: PersistedReconnectRequest) {
  const requests = readRequests().filter((entry) => entry.requestId !== request.requestId);
  writeRequests([...requests, request]);
}

export function removeReconnectRequest(requestId: string) {
  writeRequests(readRequests().filter((entry) => entry.requestId !== requestId));
}

export function readReconnectRequests(): PersistedReconnectRequest[] {
  return readRequests();
}

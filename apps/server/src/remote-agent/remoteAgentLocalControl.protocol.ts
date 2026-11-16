import { join } from "node:path";

import type {
  RemoteAgentOperationOutcome,
  RemoteAgentOperationSnapshot,
} from "./remoteAgentInstall.operation.ts";

/**
 * D1 owner-only local control socket. It serves only remote-agent status, read-only doctor and
 * install/replace (plus polling an accepted operation). It is deliberately separate from the
 * backend lock's control port and secret, which can shut the backend down.
 */
export const REMOTE_AGENT_CONTROL_VERSION = 1;
export const REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES = 64 * 1024;
export const REMOTE_AGENT_CONTROL_MAX_CLIENTS = 16;
export const REMOTE_AGENT_CONTROL_ADMISSION_MS = 5_000;
export const REMOTE_AGENT_CONTROL_MAX_WAIT_MS = 25_000;

export function remoteAgentControlSocketPath(stateDir: string): string {
  return join(stateDir, "control", "remote-agent.sock");
}

export type RemoteAgentControlRequest =
  | { readonly method: "status"; readonly target: string }
  | { readonly method: "doctor"; readonly target: string }
  | {
      readonly method: "install";
      readonly target: string;
      readonly replace: boolean;
      readonly operationId?: string;
      /** Explicit person consent (interactive yes or `--yes`); never inferred. */
      readonly consent: boolean;
    }
  | { readonly method: "operation"; readonly operationId: string; readonly waitMs: number };

export type RemoteAgentControlResponse =
  | { readonly v: 1; readonly ok: true; readonly result: unknown }
  | {
      readonly v: 1;
      readonly ok: false;
      readonly error: { readonly code: RemoteAgentControlErrorCode; readonly message: string };
    };

export type RemoteAgentControlErrorCode =
  | "invalid-request"
  | "unsupported-method"
  | "target"
  | "busy"
  | "unavailable"
  | "internal";

export interface RemoteAgentConsentRequired {
  readonly status: "consent-required";
  readonly executionTargetId: string;
  readonly message: string;
}

const OPERATION_ID = /^[0-9a-f-]{36}$/;

/** Validate one request against the allow-list; unknown fields and methods are rejected. */
export function parseRemoteAgentControlRequest(
  value: unknown,
): RemoteAgentControlRequest | { readonly error: string; readonly unsupported?: true } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "Request must be a JSON object." };
  }
  const request = value as Record<string, unknown>;
  if (request.v !== REMOTE_AGENT_CONTROL_VERSION) return { error: "Unsupported protocol version." };
  // `auth` carries the named-pipe endpoint token; the server verifies it before parsing.
  const allowed: Record<string, ReadonlyArray<string>> = {
    status: ["v", "auth", "method", "target"],
    doctor: ["v", "auth", "method", "target"],
    install: ["v", "auth", "method", "target", "replace", "consent", "operationId"],
    operation: ["v", "auth", "method", "operationId", "waitMs"],
  };
  const method = typeof request.method === "string" ? request.method : "";
  const fields = allowed[method];
  if (!fields) return { error: `Method '${method}' is not available.`, unsupported: true };
  if (Object.keys(request).some((key) => !fields.includes(key))) {
    return { error: "Request contains unsupported fields." };
  }
  if (method === "operation") {
    const waitMs = request.waitMs ?? 0;
    if (typeof request.operationId !== "string" || !OPERATION_ID.test(request.operationId)) {
      return { error: "operationId is invalid." };
    }
    if (typeof waitMs !== "number" || !Number.isInteger(waitMs) || waitMs < 0) {
      return { error: "waitMs must be a non-negative integer." };
    }
    return {
      method,
      operationId: request.operationId,
      waitMs: Math.min(waitMs, REMOTE_AGENT_CONTROL_MAX_WAIT_MS),
    };
  }
  if (typeof request.target !== "string" || request.target.length === 0) {
    return { error: "target is required." };
  }
  if (method === "install") {
    if (
      request.operationId !== undefined &&
      (typeof request.operationId !== "string" || !OPERATION_ID.test(request.operationId))
    )
      return { error: "operationId is invalid." };
    if (request.replace !== undefined && typeof request.replace !== "boolean") {
      return { error: "replace must be a boolean." };
    }
    if (request.consent !== undefined && typeof request.consent !== "boolean") {
      return { error: "consent must be a boolean." };
    }
    return {
      method,
      target: request.target,
      replace: request.replace === true,
      consent: request.consent === true,
      ...(typeof request.operationId === "string" ? { operationId: request.operationId } : {}),
    };
  }
  return { method: method as "status" | "doctor", target: request.target };
}

/** CLI exit codes from the implementation contract. */
export const REMOTE_AGENT_CLI_EXIT = {
  active: 0,
  consentRequired: 2,
  deferred: 3,
  failed: 4,
  uncertain: 5,
  backendUnavailable: 6,
} as const;

export function remoteAgentOutcomeExitCode(outcome: RemoteAgentOperationOutcome | null): number {
  switch (outcome) {
    case "active":
      return REMOTE_AGENT_CLI_EXIT.active;
    case "staged":
    case "deferred":
      return REMOTE_AGENT_CLI_EXIT.deferred;
    case "uncertain":
    case null:
      return REMOTE_AGENT_CLI_EXIT.uncertain;
    case "failed":
      return REMOTE_AGENT_CLI_EXIT.failed;
  }
}

export function isRemoteAgentOperationSnapshot(
  value: unknown,
): value is RemoteAgentOperationSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { operationId?: unknown }).operationId === "string" &&
    typeof (value as { state?: unknown }).state === "string"
  );
}

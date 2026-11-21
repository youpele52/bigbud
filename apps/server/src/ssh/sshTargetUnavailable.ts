/**
 * Typed "the SSH target cannot be used right now" errors and their detection.
 *
 * A dead SSH transport (password session expired, key not loaded in ssh-agent, unknown host key,
 * user Disconnect, unreachable host) is not a dead provider session: the same provider session
 * works again once the target is reachable. Turn-start classification uses
 * `describeRemoteTargetUnavailable` so these failures are never auto-recovered or auto-forked.
 *
 * Message texts are part of the contract with the web client (`apps/web/src/lib/ssh.ts` parses
 * them), so the builders here are the single source for both the thrown text and the fallback
 * text detection used when an adapter flattens the cause into a string.
 *
 * @module sshTargetUnavailable
 */
import type {
  TurnStartRemoteTargetAuthMode,
  TurnStartRemoteTargetFailure,
} from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";

import {
  REMOTE_TARGET_DISCONNECTED_CODE,
  REMOTE_TARGET_DISCONNECTED_MESSAGE,
} from "./sshTargetDisconnects.ts";

const SSH_PASSWORD_REQUIRED_PREFIX = "SSH password is required for ";
const SSH_PASSWORD_REQUIRED_SUFFIX = ". Re-enter it before using this target.";
export const SSH_PASSWORD_AUTH_REQUIRED_MESSAGE =
  "SSH password authentication is required before using this target.";
const SSH_KEY_PASSPHRASE_PREFIX = "SSH key '";
const SSH_KEY_PASSPHRASE_MARKER = "' requires a passphrase.";
export const SSH_HOST_TRUST_REQUIRED_PREFIX = "SSH host trust is required: ";
/** OpenSSH's own texts for a host that cannot be reached at all (no credential involved). */
const SSH_UNREACHABLE_DETAIL =
  /ssh: connect to host \S+ port \d+: (?:Connection refused|Connection timed out|Operation timed out|No route to host|Network is unreachable|Host is down)|ssh: Could not resolve hostname|Connection timed out during banner exchange/i;
const MAX_CAUSE_DEPTH = 8;

export function buildSshPasswordRequiredMessage(destination: string): string {
  return `${SSH_PASSWORD_REQUIRED_PREFIX}${destination}${SSH_PASSWORD_REQUIRED_SUFFIX}`;
}

export function buildSshKeyLoadMessage(keyPath: string): string {
  return `${SSH_KEY_PASSPHRASE_PREFIX}${keyPath}${SSH_KEY_PASSPHRASE_MARKER} Load it into ssh-agent with 'ssh-add ${keyPath}' before using this target.`;
}

export function buildSshHostTrustRequiredMessage(challengeJson: string): string {
  return `${SSH_HOST_TRUST_REQUIRED_PREFIX}${challengeJson}`;
}

/** The target needs a credential or a host-identity decision from the user before it can be used. */
export class SshTargetAuthRequiredError extends Error {
  readonly _tag = "SshTargetAuthRequiredError";

  constructor(
    readonly executionTargetId: string,
    readonly authMode: TurnStartRemoteTargetAuthMode,
    message: string,
  ) {
    super(message);
    this.name = "SshTargetAuthRequiredError";
  }
}

const authModeFromText = (text: string): TurnStartRemoteTargetAuthMode | undefined => {
  if (
    (text.includes(SSH_PASSWORD_REQUIRED_PREFIX) && text.includes(SSH_PASSWORD_REQUIRED_SUFFIX)) ||
    text.includes(SSH_PASSWORD_AUTH_REQUIRED_MESSAGE)
  ) {
    return "password";
  }
  if (text.includes(SSH_KEY_PASSPHRASE_PREFIX) && text.includes(SSH_KEY_PASSPHRASE_MARKER)) {
    return "ssh-key-passphrase";
  }
  if (text.includes(SSH_HOST_TRUST_REQUIRED_PREFIX)) return "host-trust";
  return undefined;
};

const fromText = (text: string): TurnStartRemoteTargetFailure | undefined => {
  const authMode = authModeFromText(text);
  if (authMode !== undefined) return { reason: "auth-required", authMode };
  if (text.includes(REMOTE_TARGET_DISCONNECTED_MESSAGE)) return { reason: "disconnected" };
  if (SSH_UNREACHABLE_DETAIL.test(text)) return { reason: "unreachable" };
  return undefined;
};

const readField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const stringField = (value: unknown, key: string): string | undefined => {
  const field = readField(value, key);
  return typeof field === "string" ? field : undefined;
};

/** Typed match by `_tag`/`code`, so errors from another module instance still match. */
const fromTyped = (value: unknown): TurnStartRemoteTargetFailure | undefined => {
  const tag = readField(value, "_tag");
  const executionTargetId = stringField(value, "executionTargetId");
  if (tag === "SshTargetAuthRequiredError") {
    const authMode = readField(value, "authMode") as TurnStartRemoteTargetAuthMode | undefined;
    return {
      reason: "auth-required",
      ...(executionTargetId !== undefined ? { executionTargetId } : {}),
      ...(authMode !== undefined ? { authMode } : {}),
    };
  }
  if (
    tag === "RemoteTargetDisconnectedError" ||
    readField(value, "code") === REMOTE_TARGET_DISCONNECTED_CODE
  ) {
    return {
      reason: "disconnected",
      ...(executionTargetId !== undefined ? { executionTargetId } : {}),
    };
  }
  return undefined;
};

const textsOf = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  return ["detail", "issue", "message"]
    .map((key) => stringField(value, key))
    .filter((text): text is string => text !== undefined);
};

/**
 * Describes why a turn start could not use its SSH target, or `undefined` when the failure is
 * not a remote-target failure. Walks the `.cause` chain (adapters keep the original error as
 * `cause`); typed errors win over the message fallback at every depth.
 */
export function describeRemoteTargetUnavailable(
  error: unknown,
): TurnStartRemoteTargetFailure | undefined {
  let textMatch: TurnStartRemoteTargetFailure | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    const typed = fromTyped(current);
    if (typed !== undefined) return typed;
    if (textMatch === undefined) {
      for (const text of textsOf(current)) {
        textMatch = fromText(text);
        if (textMatch !== undefined) break;
      }
    }
    const next = readField(current, "cause");
    if (next === current) break;
    current = next;
  }
  return textMatch;
}

export function isRemoteTargetUnavailable(error: unknown): boolean {
  return describeRemoteTargetUnavailable(error) !== undefined;
}

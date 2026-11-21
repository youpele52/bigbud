import type { RemoteExecutionCheckState } from "../../../stores/remoteAccess/remoteAccess.store";
import type { RemoteExecutionAuthMode } from "../../../stores/remoteAccess/remoteAccess.store";
import {
  isRemoteTargetFailureNewerThanCheck,
  type RemoteTargetFailureSignal,
  remoteTargetFailureCheck,
} from "../../../stores/remoteAccess/remoteTargetInvalidation";
import type { ThreadNavigationIntent } from "../../../stores/remoteAccess/threadNavigationIntent";

export type RemoteThreadGateState =
  | { readonly kind: "open" }
  | { readonly kind: "reconnecting"; readonly waitingForAuth: boolean }
  | { readonly kind: "auth"; readonly authMode: RemoteExecutionAuthMode }
  | { readonly kind: "error"; readonly message: string; readonly tip: string | null };

export interface RemoteThreadGateInput {
  /** The thread's workspace is an SSH target (local, Chats and non-SSH pass through). */
  readonly isRemote: boolean;
  readonly disconnectedTargetsLoaded: boolean;
  /** The user chose Disconnect: the thread opens read-only instead (decision Q2). */
  readonly userDisconnected: boolean;
  readonly check:
    | Pick<RemoteExecutionCheckState, "status" | "message" | "tip" | "authMode" | "updatedAt">
    | undefined;
  /** The thread's newest turn-start failure, when it was a remote-target failure. */
  readonly failure: RemoteTargetFailureSignal | null;
  readonly intent: ThreadNavigationIntent;
  /** This visit already ran its one automatic silent check. */
  readonly autoAttempted: boolean;
  /** The global auth dialog is already waiting on this target. */
  readonly authPending: boolean;
  /** The thread opened during this visit; a later drop shows the in-thread notice instead. */
  readonly latchedOpen: boolean;
}

export interface RemoteThreadGateDerivation {
  readonly state: RemoteThreadGateState;
  /** Start the visit's one silent reconnect now (explicit navigation to a known-dead target). */
  readonly autoCheck: boolean;
  /** Open now and verify in the background (explicit navigation, state unknown). */
  readonly backgroundCheck: boolean;
}

const OPEN: RemoteThreadGateDerivation = {
  state: { kind: "open" },
  autoCheck: false,
  backgroundCheck: false,
};

/**
 * Pure state for the route-level remote-target gate (plan section 3.1). Auto-reconnect happens
 * only on explicit navigation and only once per visit; a startup-restored thread on a dead
 * target shows the gate with Reconnect instead (decision Q6). Never reconnects in the background
 * for a restored route or an unknown target.
 */
export function deriveRemoteThreadGateState(
  input: RemoteThreadGateInput,
): RemoteThreadGateDerivation {
  if (
    !input.isRemote ||
    !input.disconnectedTargetsLoaded ||
    input.userDisconnected ||
    input.latchedOpen
  ) {
    return OPEN;
  }
  if (input.authPending) {
    return { ...OPEN, state: { kind: "reconnecting", waitingForAuth: true } };
  }
  if (input.check?.status === "checking") {
    return { ...OPEN, state: { kind: "reconnecting", waitingForAuth: false } };
  }
  const effective = isRemoteTargetFailureNewerThanCheck(input.failure, input.check)
    ? remoteTargetFailureCheck(input.failure)
    : input.check;
  if (effective?.status === "error" || effective?.status === "auth_required") {
    if (input.intent === "explicit" && !input.autoAttempted) {
      return { ...OPEN, state: { kind: "reconnecting", waitingForAuth: false }, autoCheck: true };
    }
    if (effective.status === "auth_required" && effective.authMode) {
      return { ...OPEN, state: { kind: "auth", authMode: effective.authMode } };
    }
    return { ...OPEN, state: { kind: "error", message: effective.message, tip: effective.tip } };
  }
  return {
    ...OPEN,
    backgroundCheck: input.intent === "explicit" && effective?.status !== "verified",
  };
}

export type RemoteThreadGateTone = "info" | "warning" | "error";

export interface RemoteThreadGateCopy {
  readonly tone: RemoteThreadGateTone;
  readonly title: string;
  readonly description: string | null;
  /** Primary action; `null` while an attempt is running. */
  readonly primaryLabel: string | null;
}

const AUTH_COPY: Record<RemoteExecutionAuthMode, { title: string; action: string }> = {
  password: { title: "needs your SSH password", action: "Enter password" },
  "ssh-key-passphrase": { title: "needs your SSH key passphrase", action: "Unlock key" },
  "host-trust": { title: "", action: "Review identity" },
};

const WAITING_COPY: Record<RemoteExecutionAuthMode, string> = {
  password: "Waiting for password…",
  "ssh-key-passphrase": "Waiting for key passphrase…",
  "host-trust": "Waiting for server identity confirmation…",
};

/** Gate screen copy: blue while working, amber when input is needed, red on failure. */
export function describeRemoteThreadGate(
  state: Exclude<RemoteThreadGateState, { kind: "open" }>,
  hostLabel: string,
  pendingAuthMode: RemoteExecutionAuthMode | null = null,
): RemoteThreadGateCopy {
  if (state.kind === "reconnecting") {
    return {
      tone: "info",
      title: state.waitingForAuth
        ? WAITING_COPY[pendingAuthMode ?? "password"]
        : `Reconnecting to ${hostLabel}…`,
      description: null,
      primaryLabel: null,
    };
  }
  if (state.kind === "auth") {
    return {
      tone: "warning",
      title:
        state.authMode === "host-trust"
          ? `Confirm ${hostLabel}'s server identity`
          : `${hostLabel} ${AUTH_COPY[state.authMode].title}`,
      description: null,
      primaryLabel: AUTH_COPY[state.authMode].action,
    };
  }
  return {
    tone: "error",
    title: `Could not reach ${hostLabel}`,
    description: state.tip ? `${state.message} ${state.tip}` : state.message,
    primaryLabel: "Reconnect",
  };
}

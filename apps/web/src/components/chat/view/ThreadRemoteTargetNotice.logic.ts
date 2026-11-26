import type {
  RemoteExecutionAuthMode,
  RemoteExecutionCheckState,
} from "../../../stores/remoteAccess/remoteAccess.store";
import type { RemoteTargetFailureSignal } from "../../../stores/remoteAccess/remoteTargetInvalidation";

export type ThreadRemoteTargetNoticeState =
  /** The user chose Disconnect: the thread is read-only (decision Q2). */
  | { readonly kind: "disconnected" }
  /** The last message did not send because the target was unavailable. */
  | {
      readonly kind: "unavailable";
      readonly authMode: RemoteExecutionAuthMode | null;
      readonly checking: boolean;
    }
  /** Access is back after the failure: offer Resend (decision Q4; never automatic). */
  | { readonly kind: "reconnected"; readonly canResend: boolean };

export function deriveThreadRemoteTargetNotice(input: {
  readonly isRemote: boolean;
  readonly userDisconnected: boolean;
  readonly failure: RemoteTargetFailureSignal | null;
  readonly check: Pick<RemoteExecutionCheckState, "status" | "authMode" | "updatedAt"> | undefined;
  /** The unsent message can be resent as is (images must be re-added in the composer). */
  readonly canResend: boolean;
}): ThreadRemoteTargetNoticeState | null {
  if (!input.isRemote) return null;
  if (input.userDisconnected) return { kind: "disconnected" };
  const { failure, check } = input;
  if (!failure) return null;
  if (check?.status === "verified" && Date.parse(check.updatedAt) > Date.parse(failure.createdAt)) {
    return { kind: "reconnected", canResend: input.canResend };
  }
  return {
    kind: "unavailable",
    authMode:
      check?.status === "auth_required" && check.authMode
        ? check.authMode
        : (failure.remoteTarget.authMode ?? null),
    checking: check?.status === "checking",
  };
}

const UNAVAILABLE_ACTION: Record<RemoteExecutionAuthMode, string> = {
  password: "Enter password",
  "ssh-key-passphrase": "Unlock key",
  "host-trust": "Review identity",
};

export function describeThreadRemoteTargetNotice(
  state: ThreadRemoteTargetNoticeState,
  hostLabel: string,
): {
  readonly variant: "warning" | "success" | "loading";
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string | null;
} {
  if (state.kind === "disconnected") {
    return {
      variant: "warning",
      title: `${hostLabel} is disconnected`,
      description:
        "This thread is read-only while its workspace is disconnected. Reconnect to keep working.",
      actionLabel: "Reconnect",
    };
  }
  if (state.kind === "reconnected") {
    return {
      variant: "success",
      title: `Reconnected to ${hostLabel}`,
      description: state.canResend
        ? "Your last message was not sent. Resend it when you are ready."
        : "Your last message was not sent. Send it again from the composer and re-add its images.",
      actionLabel: state.canResend ? "Resend" : null,
    };
  }
  if (state.checking) {
    return {
      variant: "loading",
      title: `Reconnecting to ${hostLabel}…`,
      description: "Your message was not sent.",
      actionLabel: null,
    };
  }
  return {
    variant: "warning",
    title: `${hostLabel} is not connected`,
    description: "Your message was not sent.",
    actionLabel: state.authMode ? UNAVAILABLE_ACTION[state.authMode] : "Reconnect",
  };
}

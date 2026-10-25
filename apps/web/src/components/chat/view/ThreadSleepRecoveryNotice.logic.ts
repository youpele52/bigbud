import type { CommandId, ThreadId } from "@bigbud/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@bigbud/contracts/constants/provider.constant.ts";
import type {
  ThreadRecovery,
  ThreadRecoveryResolveAction,
  ThreadRecoveryResolveCommand,
} from "@bigbud/contracts/orchestration/orchestration.recovery.ts";

/** A continuation that succeeds this quickly never flashes the "Resuming" notice. */
export const RESUMING_NOTICE_DELAY_MS = 3_000;
/** How long "<Provider> continued on its own after sleep." stays visible. */
export const PROVIDER_CONTINUED_NOTICE_MS = 6_000;
/** The server parks a turn after this many failed automatic continuations. */
export const SLEEP_RECOVERY_PARK_LIMIT = 3;

export type SleepRecoveryNoticeKind =
  | "resuming"
  | "provider-continued"
  | "interrupted"
  | "tool-outcome-unknown"
  | "no-activity"
  | "backend-restarted"
  | "resume-failed"
  | "parked";

/** Alert variants per AGENTS.md: blue working or informational, amber warning, red failure. */
export type SleepRecoveryNoticeTone = "info" | "warning" | "error";

export interface SleepRecoveryNoticeAction {
  readonly action: ThreadRecoveryResolveAction;
  readonly label: string;
}

export interface SleepRecoveryNotice {
  readonly kind: SleepRecoveryNoticeKind;
  readonly tone: SleepRecoveryNoticeTone;
  readonly description: string;
  readonly actions: ReadonlyArray<SleepRecoveryNoticeAction>;
}

export interface SleepRecoveryNoticeDerivation {
  readonly notice: SleepRecoveryNotice | null;
  /** Milliseconds until the derived notice can change without new input, if ever. */
  readonly nextChangeInMs: number | null;
}

const CONTINUE_OR_DISMISS: ReadonlyArray<SleepRecoveryNoticeAction> = [
  { action: "continue", label: "Continue" },
  { action: "dismiss", label: "Dismiss" },
];

/**
 * Identifies one visible recovery state of one interrupted turn. Timing and dismissal key off
 * it, so a newer state (another status, reason, try or turn) shows again, while a server
 * refresh of the same state (a new `updatedAt`) does not restart the 3 s or 6 s clocks. The
 * server keeps `reason` across tries, so the try count (`attempt`) tells them apart.
 */
export function sleepRecoveryStateKey(recovery: ThreadRecovery): string {
  return [recovery.messageId, recovery.status, recovery.reason ?? "", recovery.attempt].join("\0");
}

export function sleepRecoveryProviderName(provider: ThreadRecovery["provider"]): string {
  if (provider !== null && Object.hasOwn(PROVIDER_DISPLAY_NAMES, provider)) {
    return (PROVIDER_DISPLAY_NAMES as Record<string, string>)[provider]!;
  }
  return "The provider";
}

function awaitingUserNotice(recovery: ThreadRecovery): SleepRecoveryNotice {
  if (recovery.reason === "no-activity-after-wake") {
    return {
      kind: "no-activity",
      tone: "warning",
      description: "No activity since wake.",
      actions: [
        { action: "keep-waiting", label: "Keep waiting" },
        { action: "stop-and-continue", label: "Stop and continue" },
      ],
    };
  }
  if (recovery.reason === "backend-restarted-after-wake") {
    return {
      kind: "backend-restarted",
      tone: "warning",
      description: "bigbud restarted after wake. This turn's outcome is unknown.",
      actions: CONTINUE_OR_DISMISS,
    };
  }
  if (recovery.reason === "continuation-failed") {
    // The user's own Continue or Retry did not start: a failure, in red.
    return {
      kind: "resume-failed",
      tone: "error",
      description: "Couldn't resume after sleep.",
      actions: CONTINUE_OR_DISMISS,
    };
  }
  if (recovery.reason === "tool-in-flight") {
    // A tool may have been running. Its outcome is "unknown": never "failed" or "cancelled".
    return {
      kind: "tool-outcome-unknown",
      tone: "warning",
      description: `The computer slept while ${recovery.toolSummary?.trim() || "a tool"} was running. Its outcome is unknown. Check before continuing.`,
      actions: CONTINUE_OR_DISMISS,
    };
  }
  // Cut with no tool running, but not continued on its own: automatic continuation is off,
  // or the thread stayed busy or offline after wake.
  return {
    kind: "interrupted",
    tone: "warning",
    description: "The response was interrupted when the computer went to sleep.",
    actions: CONTINUE_OR_DISMISS,
  };
}

/**
 * The thread's sleep and wake recovery notice. `observedAtMs` is when this browser first saw the
 * current state (`sleepRecoveryStateKey`); durations never subtract server timestamps.
 */
export function deriveSleepRecoveryNotice(input: {
  readonly recovery: ThreadRecovery | null | undefined;
  readonly observedAtMs: number | null;
  readonly nowMs: number;
}): SleepRecoveryNoticeDerivation {
  const { recovery, nowMs } = input;
  if (!recovery) return { notice: null, nextChangeInMs: null };
  const elapsedMs = Math.max(0, nowMs - (input.observedAtMs ?? nowMs));
  switch (recovery.status) {
    case "continuing": {
      if (elapsedMs < RESUMING_NOTICE_DELAY_MS) {
        return { notice: null, nextChangeInMs: RESUMING_NOTICE_DELAY_MS - elapsedMs };
      }
      return {
        notice: {
          kind: "resuming",
          tone: "info",
          description: "Resuming after sleep…",
          actions: [],
        },
        nextChangeInMs: null,
      };
    }
    case "provider-continued": {
      if (elapsedMs >= PROVIDER_CONTINUED_NOTICE_MS) return { notice: null, nextChangeInMs: null };
      return {
        notice: {
          kind: "provider-continued",
          tone: "info",
          description: `${sleepRecoveryProviderName(recovery.provider)} continued on its own after sleep.`,
          actions: [],
        },
        nextChangeInMs: PROVIDER_CONTINUED_NOTICE_MS - elapsedMs,
      };
    }
    case "awaiting-user":
      return { notice: awaitingUserNotice(recovery), nextChangeInMs: null };
    case "parked": {
      const tries = recovery.attempt > 0 ? recovery.attempt : SLEEP_RECOVERY_PARK_LIMIT;
      return {
        notice: {
          kind: "parked",
          tone: "error",
          description: `Couldn't resume after ${tries} tries.`,
          actions: [{ action: "retry", label: "Retry" }],
        },
        nextChangeInMs: null,
      };
    }
    default:
      // none, interrupted-by-sleep, observing and continued show nothing.
      return { notice: null, nextChangeInMs: null };
  }
}

/** Builds the `thread.recovery.resolve` command for a notice action. */
export function buildThreadRecoveryResolveCommand(input: {
  readonly threadId: ThreadId;
  readonly recovery: Pick<ThreadRecovery, "messageId">;
  readonly action: ThreadRecoveryResolveAction;
  readonly commandId: CommandId;
  readonly createdAt: string;
}): ThreadRecoveryResolveCommand {
  return {
    type: "thread.recovery.resolve",
    commandId: input.commandId,
    threadId: input.threadId,
    action: input.action,
    // Lets the server refuse an action on a prompt that a newer turn already replaced.
    messageId: input.recovery.messageId,
    createdAt: input.createdAt,
  };
}

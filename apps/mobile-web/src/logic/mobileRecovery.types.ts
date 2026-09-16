import type {
  MobileRecoveryBaseline,
  MobileRecoveryFrame,
} from "@bigbud/contracts/server/mobile.recovery";
import type { ThreadId } from "@bigbud/contracts";

import { MobileRecoveryUnsupportedError } from "../lib/mobileRpc.errors";
import type { MobileRpcClient } from "../lib/mobileRpc";
import type { MobileQueryClient, MobileSyncScheduler } from "./mobileOrchestrationSync.logic";

export type MobileRecoveryFreshness = "unavailable" | "refreshing" | "current" | "stale" | "legacy";

export type MobileSelectedThreadStatus = "none" | "unknown" | "present" | "missing" | "deleted";

export interface MobileRecoveryState {
  readonly freshness: MobileRecoveryFreshness;
  readonly snapshotSequence: number | null;
  readonly throughSequence: number | null;
  readonly selectedThreadId: ThreadId | null;
  readonly selectedThreadStatus: MobileSelectedThreadStatus;
  readonly lastRefreshedAt: number | null;
  readonly lastSynchronizedAt: number | null;
  readonly reason: string | null;
  readonly actionsAvailable: boolean;
}

export function initialMobileRecoveryState(
  freshness: MobileRecoveryFreshness = "unavailable",
): MobileRecoveryState {
  return {
    freshness,
    snapshotSequence: null,
    throughSequence: null,
    selectedThreadId: null,
    selectedThreadStatus: "none",
    lastSynchronizedAt: null,
    lastRefreshedAt: null,
    reason: null,
    actionsAvailable: false,
  };
}

export type RecoveryClient = Pick<
  MobileRpcClient,
  | "getMobileRecoveryBaseline"
  | "startMobileRecoveryStream"
  | "getSnapshot"
  | "getMobileThread"
  | "onDomainEvent"
>;

export type RecoveryQueryClient = MobileQueryClient & {
  getQueryData?<T>(queryKey: ReadonlyArray<string>): T | undefined;
};

export type RecoveryScheduler = MobileSyncScheduler & {
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
};

export interface MobileRecoveryController {
  readonly start: () => void;
  readonly transportOpened: () => void;
  readonly transportClosed: () => void;
  readonly refresh: (selectedThreadId?: ThreadId | null) => Promise<MobileRecoveryBaseline>;
  readonly selectThread: (threadId: ThreadId) => Promise<MobileRecoveryBaseline>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => MobileRecoveryState;
  readonly dispose: () => void;
}

export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
export const MOBILE_RECOVERY_ATTEMPT_TIMEOUT_MS = 20_000;

export function defaultRecoveryScheduler(): RecoveryScheduler {
  return {
    queueMicrotask,
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
  };
}

export function recoveryErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return String(error);
}

export function isMobileRecoveryBaselineConsistent(
  baseline: MobileRecoveryBaseline,
  expectedAttemptId: string,
  selectedThreadId: ThreadId | null,
): boolean {
  return (
    baseline.recoveryAttemptId === expectedAttemptId &&
    baseline.version === 1 &&
    baseline.snapshot.snapshotSequence === baseline.snapshotSequence &&
    (selectedThreadId === null) === (baseline.selectedThread === null) &&
    (baseline.selectedThread?.status !== "present" ||
      baseline.selectedThread.thread.id === selectedThreadId)
  );
}

export function describeRecoveryReason(reason: string | null): string | null {
  if (reason === null) return null;
  switch (reason) {
    case "gap":
      return "Live updates had a sequence gap.";
    case "overflow":
      return "Recovery exceeded its bounded event window.";
    case "unavailable":
      return "The server could not provide recovery data.";
    case "invalid-cursor":
      return "The cached recovery cursor is no longer valid.";
    case "timeout":
    case "recovery-timeout":
      return "Recovery took too long to complete.";
    case "recovery-stream-ended":
      return "The recovery stream ended before synchronization completed.";
    case "recovery-stream-error":
      return "The recovery stream failed before synchronization completed.";
    case "recovery-unsupported":
      return "This server does not expose versioned recovery markers.";
    default:
      return reason;
  }
}

export function isUnsupportedRecoveryError(error: unknown): boolean {
  return error instanceof MobileRecoveryUnsupportedError;
}

export function snapshotKey(sessionId: string) {
  return ["mobile-snapshot", sessionId] as const;
}

export function threadKey(sessionId: string, threadId: ThreadId) {
  return ["mobile-thread", sessionId, threadId] as const;
}

export function makeAttemptId(generation: number): string {
  return `mobile-recovery-${generation}-${crypto.randomUUID()}`;
}

export type { MobileRecoveryBaseline, MobileRecoveryFrame };

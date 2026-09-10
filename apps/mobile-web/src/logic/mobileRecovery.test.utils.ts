import type {
  MobileRecoveryBaseline,
  MobileRecoveryFrame,
} from "@bigbud/contracts/server/mobile.recovery";
import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import { vi } from "vitest";

export const sessionId = "mobile-session";
export const serverEpoch = "server-epoch-1";

export function makeSnapshot(snapshotSequence: number): OrchestrationReadModel {
  return {
    snapshotSequence,
    updatedAt: "2026-09-09T00:00:00.000Z",
    projects: [],
    threads: [],
  };
}

export function makeBaseline(
  recoveryAttemptId: string,
  snapshotSequence: number,
  selectedThread: MobileRecoveryBaseline["selectedThread"] = null,
): MobileRecoveryBaseline {
  return {
    version: 1,
    recoveryAttemptId,
    serverEpoch,
    snapshotSequence,
    snapshot: makeSnapshot(snapshotSequence),
    selectedThread,
  };
}

export function makeFrame(
  recoveryAttemptId: string,
  frame:
    | {
        readonly type: "batch";
        readonly batchId: string;
        readonly events: ReadonlyArray<OrchestrationEvent>;
      }
    | { readonly type: "caught-up"; readonly throughSequence: number }
    | {
        readonly type: "resync-required";
        readonly reason: "gap" | "overflow" | "unavailable" | "invalid-cursor" | "timeout";
      },
): MobileRecoveryFrame {
  return {
    ...frame,
    version: 1,
    route: "direct-unmanaged",
    recoveryAttemptId,
    serverEpoch,
  };
}

export function makeEvent(sequence: number): OrchestrationEvent {
  return {
    type: "thread.message-sent",
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: "2026-09-09T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: "thread-1",
      messageId: "message-1",
      role: "assistant",
      text: "Hello",
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    },
  } as unknown as OrchestrationEvent;
}

export function makeQueryClient() {
  const values = new Map<string, unknown>();
  return {
    setQueryData<T>(
      queryKey: ReadonlyArray<string>,
      updater: (current: T | undefined) => T | undefined,
    ) {
      const key = JSON.stringify(queryKey);
      const next = updater(values.get(key) as T | undefined);
      if (next === undefined) values.delete(key);
      else values.set(key, next);
    },
    getQueryData<T>(queryKey: ReadonlyArray<string>) {
      return values.get(JSON.stringify(queryKey)) as T | undefined;
    },
    removeQueries({ queryKey }: { readonly queryKey: ReadonlyArray<string> }) {
      values.delete(JSON.stringify(queryKey));
    },
    invalidateQueries: vi.fn(async () => undefined),
  };
}

export function makeStreamHarness() {
  let current: {
    readonly recoveryAttemptId: string;
    readonly dispatchFrame: (frame: MobileRecoveryFrame) => void;
    readonly onExit: () => void;
  } | null = null;
  const runs: Array<{
    readonly recoveryAttemptId: string;
    readonly serverEpoch: string;
    readonly baselineSequence: number;
    readonly dispatchFrame: (frame: MobileRecoveryFrame) => void;
    readonly onExit: () => void;
  }> = [];
  const cancel = vi.fn();
  return {
    startStream(input: {
      readonly recoveryAttemptId: string;
      readonly serverEpoch: string;
      readonly baselineSequence: number;
      readonly dispatchFrame: (frame: MobileRecoveryFrame) => void;
      readonly onExit: () => void;
    }) {
      current = input;
      runs.push(input);
      return cancel;
    },
    dispatch(frame: MobileRecoveryFrame) {
      current?.dispatchFrame(frame);
    },
    exit() {
      current?.onExit();
    },
    runs,
    cancel,
  };
}

export function makeScheduler() {
  const timeoutCallbacks: Array<() => void> = [];
  const microtaskCallbacks: Array<() => void> = [];
  return {
    queueMicrotask: vi.fn((callback: () => void) => {
      microtaskCallbacks.push(callback);
    }),
    setTimeout: vi.fn((callback: () => void) => {
      timeoutCallbacks.push(callback);
      return timeoutCallbacks.length;
    }),
    clearTimeout: vi.fn(),
    microtaskCallbacks,
    timeoutCallbacks,
  };
}

export async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

export function makeClient(input: {
  readonly readBaseline: (
    baselineInput: {
      recoveryAttemptId: string;
    },
    signal?: AbortSignal,
  ) => Promise<MobileRecoveryBaseline>;
  readonly stream: ReturnType<typeof makeStreamHarness>;
  readonly snapshot?: OrchestrationReadModel;
}) {
  return {
    getMobileRecoveryBaseline: input.readBaseline,
    startMobileRecoveryStream: input.stream.startStream,
    getSnapshot: vi.fn(async () => input.snapshot ?? makeSnapshot(0)),
    getMobileThread: vi.fn(async () => {
      throw new Error("Thread not found.");
    }),
    onDomainEvent: vi.fn(() => () => undefined),
  };
}

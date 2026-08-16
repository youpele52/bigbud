import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderSession,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type {
  ProviderAdapterError,
  ProviderAdapterSessionNotFoundError,
} from "../src/provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
} from "../src/provider/Services/ProviderAdapter.ts";

import type { FixtureProviderRuntimeEvent } from "./TestProviderAdapter.integration.fixtureEvents.ts";

export interface TestTurnResponse {
  readonly events: ReadonlyArray<FixtureProviderRuntimeEvent>;
  readonly deferCompletion?: boolean;
  readonly mutateWorkspace?: (input: {
    readonly cwd: string;
    readonly turnCount: number;
  }) => Effect.Effect<void, never>;
}

export interface TestProviderAdapterHarness {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly provider: ProviderKind;
  readonly queueTurnResponse: (
    threadId: ThreadId,
    response: TestTurnResponse,
  ) => Effect.Effect<void, ProviderAdapterSessionNotFoundError>;
  readonly queueTurnResponseForNextSession: (
    response: TestTurnResponse,
  ) => Effect.Effect<void, never>;
  readonly getStartCount: () => number;
  readonly getRollbackCalls: (threadId: ThreadId) => ReadonlyArray<number>;
  readonly getInterruptCalls: (threadId: ThreadId) => ReadonlyArray<TurnId | undefined>;
  readonly listActiveSessionIds: () => ReadonlyArray<ThreadId>;
  readonly getApprovalResponses: (threadId: ThreadId) => ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly decision: ProviderApprovalDecision;
  }>;
  readonly getSentTurnInputs: () => ReadonlyArray<string>;
  readonly setSession: (session: ProviderSession) => Effect.Effect<void, never>;
  readonly removeSession: (threadId: ThreadId) => Effect.Effect<void, never>;
  readonly failNextListSessions: () => Effect.Effect<void, never>;
  readonly hangNextListSessions: () => Effect.Effect<void, never>;
}

export interface SessionState {
  session: ProviderSession;
  snapshot: ProviderThreadSnapshot;
  turnCount: number;
  readonly queuedResponses: Array<TestTurnResponse>;
  readonly rollbackCalls: Array<number>;
}

export interface MakeTestProviderAdapterHarnessOptions {
  readonly provider?: ProviderKind;
}

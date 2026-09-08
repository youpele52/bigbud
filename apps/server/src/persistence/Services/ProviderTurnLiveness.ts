import type { ProviderKind, ProviderRuntimeEvent, ThreadId, TurnId } from "@bigbud/contracts";
import type {
  ProviderTurnInspectionState,
  ProviderTurnLiveness,
} from "@bigbud/contracts/orchestration/providerTurnLiveness";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface ProviderTurnLivenessRepositoryShape {
  readonly startTurn: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly provider: ProviderKind;
    readonly sessionEpoch: number;
    readonly startedAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly observeEvent: (
    event: ProviderRuntimeEvent,
    meaningful: boolean,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly recordInspection: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly sessionEpoch: number;
    readonly observedAt: string;
    readonly status: ProviderTurnInspectionState;
    readonly failed: boolean;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly markTerminal: (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
    readonly sessionEpoch?: number;
    readonly terminalAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly claimTerminal: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly sessionEpoch: number;
    readonly provider: ProviderKind;
    readonly terminalAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly markMonitoringLost: (input: {
    readonly provider: ProviderKind;
    readonly observedAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<ProviderTurnLiveness>,
    PersistenceSqlError
  >;
}

export class ProviderTurnLivenessRepository extends ServiceMap.Service<
  ProviderTurnLivenessRepository,
  ProviderTurnLivenessRepositoryShape
>()("bigbud/persistence/Services/ProviderTurnLivenessRepository") {}

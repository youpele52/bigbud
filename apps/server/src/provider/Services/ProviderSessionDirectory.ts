import type {
  ExecutionTargetId,
  ProviderKind,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@bigbud/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";
import type { ProviderSessionRuntimeListInput } from "../../persistence/Services/ProviderSessionRuntime.ts";
import type { CodexRewindMarker } from "./ProviderRewind.ts";
import type {
  InspectionTerminal,
  InspectionTerminalConsumer,
} from "./ProviderInspectionTerminal.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly providerRuntimeExecutionTargetId?: ExecutionTargetId;
  readonly workspaceExecutionTargetId?: ExecutionTargetId;
  readonly executionTargetId?: ExecutionTargetId;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
  readonly lastSeenAt?: string;
}

export type ProviderSessionDirectoryReadError = ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export interface ProviderSessionDirectoryShape {
  readonly recordCodexCompaction?: (
    input: import("./ProviderCompaction.ts").CodexCompactionConfirmation,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;
  readonly storeInspectionTerminal?: (
    record: InspectionTerminal,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;
  readonly acknowledgeInspectionTerminal?: (
    threadId: ThreadId,
    eventId: string,
    consumer: InspectionTerminalConsumer,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;
  readonly listInspectionTerminals?: (
    after?: string,
  ) => Effect.Effect<ReadonlyArray<InspectionTerminal>, ProviderSessionDirectoryReadError>;
  /** Only this operation may change the reserved rewind marker. Clear is operation-fenced. */
  readonly setCodexRewind?: (
    threadId: ThreadId,
    marker: CodexRewindMarker | null,
    operationId: string,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;
  readonly upsert: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  readonly getProvider: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderKind, ProviderSessionDirectoryReadError>;

  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, ProviderSessionDirectoryReadError>;

  readonly remove: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProviderSessionDirectoryPersistenceError>;

  readonly listThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProviderSessionDirectoryPersistenceError
  >;

  /**
   * List all persisted runtime bindings in one repository read.
   *
   * Reconciliation uses this bulk operation instead of listing thread ids and
   * issuing one getBinding query per historical row.
   */
  readonly listBindings: (
    input?: ProviderSessionRuntimeListInput,
  ) => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBinding>,
    ProviderSessionDirectoryPersistenceError
  >;
}

export class ProviderSessionDirectory extends ServiceMap.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("t3/provider/Services/ProviderSessionDirectory") {}

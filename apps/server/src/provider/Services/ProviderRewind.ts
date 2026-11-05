import type { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type {
  ProviderActiveTurnInspection,
  ProviderSession,
} from "@bigbud/contracts/orchestration/provider.ts";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";

/** Codex preserves native turn IDs in canonical turn/checkpoint records, without renaming. */
export interface ProviderExactRewindInput {
  readonly threadId: ThreadId;
  readonly operationId: string;
  readonly expectedTurnIds: ReadonlyArray<TurnId>;
  readonly targetTurnCount: number;
  readonly currentTurnCount: number;
  readonly retainedTurnId: TurnId | null;
  readonly firstRemovedTurnId: TurnId | null;
  readonly checkpointRef: string;
  readonly sessionEpoch: number;
  /** Server-owned durable manual-turn/item proofs, never accepted from the browser. */
  readonly maintenanceTurns?: Readonly<Record<string, string>>;
}

export interface ProviderPreparedRewind extends ProviderExactRewindInput {
  readonly nativeThreadId: string;
  readonly runtimeVersion: string;
  readonly nativeTurnIds?: ReadonlyArray<TurnId>;
}

export interface CodexRewindMarker extends ProviderPreparedRewind {
  readonly runtime?: Pick<
    ProviderSession,
    "cwd" | "providerRuntimeExecutionTargetId" | "workspaceExecutionTargetId" | "executionTargetId"
  >;
  readonly stage:
    | "prepared"
    | "dispatched-uncertain"
    | "native-verified"
    | "files-restored"
    | "canonical-complete";
}

export const CODEX_REWIND_KEY = "bigbud.codex.rewind";

/** Any non-null marker, including an unknown future format, blocks admission. */
export function hasCodexRewindMarker(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    CODEX_REWIND_KEY in payload &&
    payload[CODEX_REWIND_KEY] != null
  );
}

/** Internal inspection envelope; the canonical status union is unchanged. */
export type ProviderTurnInspection = ProviderActiveTurnInspection & {
  readonly reconciliationEvents?: ReadonlyArray<ProviderRuntimeEvent>;
  readonly terminalEvent?: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
};

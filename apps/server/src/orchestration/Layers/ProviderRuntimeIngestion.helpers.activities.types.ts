import type {
  ApprovalRequestId,
  ProviderRuntimeEvent,
  ThreadTokenUsageSnapshot,
  TurnId,
} from "@bigbud/contracts";

export interface RuntimeEventActivityHelpers {
  readonly toTurnId: (value: TurnId | string | undefined) => TurnId | undefined;
  readonly toApprovalRequestId: (value: string | undefined) => ApprovalRequestId | undefined;
  readonly truncateDetail: (value: string, limit?: number) => string;
  readonly requestKindFromCanonicalRequestType: (
    requestType: string | undefined,
  ) => "browser" | "command" | "file-read" | "file-change" | undefined;
  readonly buildContextWindowActivityPayload: (
    event: ProviderRuntimeEvent,
  ) => ThreadTokenUsageSnapshot | undefined;
}

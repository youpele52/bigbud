import type {
  ThreadOrganizationNativeOperation,
  ThreadOrganizationNativeOutcome,
} from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";

export interface PreparedOrganizationOperation {
  readonly operation: ThreadOrganizationNativeOperation;
  readonly outcome: ThreadOrganizationNativeOutcome | null;
}

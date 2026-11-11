import type { ThreadOrganizationNativeOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
import type { OrchestrationCommand } from "@bigbud/contracts";
import type { Deferred } from "effect";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationCommandPayloadDigest } from "../commandDigest.ts";

import type { MetadataCommitIdentity } from "./ThreadMetadataGeneration.identity.ts";

export interface CommandEnvelope {
  readonly metadataCommit?: MetadataCommitIdentity;
  readonly worktreeOperationId?: string;
  readonly nativeWorkspaceOperationId?: string;
  readonly nativeOrganizationOperation?: ThreadOrganizationNativeOperation;
  readonly expectedWorktreePath?: { readonly value: string | null };
  readonly expectedWorktreeIdentity?: { readonly path: string; readonly identity: string };
  readonly command: OrchestrationCommand;
  readonly payloadDigest: OrchestrationCommandPayloadDigest;
  readonly result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  readonly startedAtMs: number;
}

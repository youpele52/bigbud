/**
 * ThreadBranchCopy - server-side branches. The branch thread is created from the request's
 * metadata, then the source's messages up to the branch point are copied from the projection
 * in bounded batches, with progress recorded durably so a restart resumes the copy.
 *
 * @module ThreadBranchCopy
 */
import type {
  OrchestrationStartThreadBranchError,
  StartThreadBranchInput,
  ThreadBranchCopyStatus,
} from "@bigbud/contracts/orchestration/orchestration.branchCopy.ts";
import type { ThreadId } from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ThreadBranchCopyShape {
  /**
   * Fixes the branch point, records the job and starts copying in the background. Starting a
   * branch id that already has a job returns its status instead of starting again.
   */
  readonly start: (
    input: StartThreadBranchInput,
  ) => Effect.Effect<ThreadBranchCopyStatus, OrchestrationStartThreadBranchError>;
  readonly status: (
    branchThreadId: ThreadId,
  ) => Effect.Effect<ThreadBranchCopyStatus | null, ProjectionRepositoryError>;
  /** Copies one job to the end (or failure) now; resumes from its recorded batch. */
  readonly runJob: (branchThreadId: ThreadId) => Effect.Effect<void>;
}

export class ThreadBranchCopy extends ServiceMap.Service<ThreadBranchCopy, ThreadBranchCopyShape>()(
  "bigbud/orchestration/Services/ThreadBranchCopy",
) {}

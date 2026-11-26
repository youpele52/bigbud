import { ServiceMap } from "effect";

export interface WorkspaceMutationWatchOwnerInput {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly relativePath: string;
}

/** Optional direct SSH owner for mutations and individual directory snapshots. */
export interface WorkspaceMutationWatchOwnerShape {
  readonly snapshotDirectory: (
    input: WorkspaceMutationWatchOwnerInput,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly writeFile: (
    input: WorkspaceMutationWatchOwnerInput & { readonly contents: string },
  ) => Promise<void>;
  /**
   * The owner's largest UTF-8 write. A larger body is refused before dispatch
   * (`not-dispatched`), so it is never reported as an uncertain write.
   */
  readonly maxWriteBytes?: number;
}

export class WorkspaceMutationWatchOwner extends ServiceMap.Service<
  WorkspaceMutationWatchOwner,
  WorkspaceMutationWatchOwnerShape
>()("t3/workspace/Services/WorkspaceMutationWatchOwner") {}

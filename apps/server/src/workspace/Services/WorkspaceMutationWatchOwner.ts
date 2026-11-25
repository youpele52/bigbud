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
}

export class WorkspaceMutationWatchOwner extends ServiceMap.Service<
  WorkspaceMutationWatchOwner,
  WorkspaceMutationWatchOwnerShape
>()("t3/workspace/Services/WorkspaceMutationWatchOwner") {}

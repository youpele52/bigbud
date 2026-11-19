import { Effect, Layer } from "effect";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { WorkspaceEntries } from "../workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { LocalWorkspaceAgent } from "../workspace-runtime/Services/LocalWorkspaceAgent.ts";
import { WorkspaceSearch } from "../workspace-runtime/Services/WorkspaceSearch.ts";
import { makeLocalWorkspaceContentSearch } from "./localWorkspaceSearch.ts";

/**
 * Local content search goes to the shared local agent; direct-SSH targets keep `rg` on the host
 * (plan Q5). Entry search is unchanged.
 */
export function makeLocalWorkspaceSearchLayer() {
  return Layer.effect(
    WorkspaceSearch,
    Effect.gen(function* () {
      const fileSystem = yield* WorkspaceFileSystem;
      const entries = yield* WorkspaceEntries;
      const local = makeLocalWorkspaceContentSearch(
        yield* LocalWorkspaceAgent,
        yield* WorkspacePaths,
      );
      return {
        searchEntries: entries.search,
        searchFileContents: (input) =>
          isLocalExecutionTarget(input.executionTargetId)
            ? local(input)
            : fileSystem.searchFileContents(input),
      };
    }),
  );
}

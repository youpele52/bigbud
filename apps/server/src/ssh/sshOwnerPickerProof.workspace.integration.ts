import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
import { ServerConfig } from "../startup/config.ts";
import { WorkspaceEntriesLive } from "../workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "../workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { WorkspaceContentSearchOwner } from "../workspace/Services/WorkspaceContentSearchOwner.ts";
import { WorkspaceDirectoryReadOwner } from "../workspace/Services/WorkspaceDirectoryReadOwner.ts";
import { WorkspaceFileReadOwner } from "../workspace/Services/WorkspaceFileReadOwner.ts";
import { WorkspaceIndexReadOwner } from "../workspace/Services/WorkspaceIndexReadOwner.ts";
import { WorkspaceMutationWatchOwner } from "../workspace/Services/WorkspaceMutationWatchOwner.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  workspaceContentSearchForPickerProof,
  workspaceDirectoryForPickerProof,
  workspaceIndexForPickerProof,
  workspaceMutationWatchForPickerProof,
  workspaceReadsForPickerProof,
} from "./sshOwnerPickerProof.workspace.ts";

/** No production composition provides these proof ports. */
export function workspaceForOwner(owner: PickerProofOwner, root: string) {
  const entries = WorkspaceEntriesLive.pipe(
    Layer.provide(
      Layer.succeed(WorkspaceDirectoryReadOwner, workspaceDirectoryForPickerProof(owner)),
    ),
    Layer.provide(Layer.succeed(WorkspaceIndexReadOwner, workspaceIndexForPickerProof(owner))),
    Layer.provide(WorkspacePathsLive),
  );
  return WorkspaceFileSystemLive.pipe(
    Layer.provide(
      Layer.succeed(WorkspaceContentSearchOwner, workspaceContentSearchForPickerProof(owner)),
    ),
    Layer.provide(Layer.succeed(WorkspaceFileReadOwner, workspaceReadsForPickerProof(owner))),
    Layer.provide(
      Layer.succeed(WorkspaceMutationWatchOwner, workspaceMutationWatchForPickerProof(owner)),
    ),
    Layer.provide(WorkspacePathsLive),
    Layer.provideMerge(entries),
    Layer.provide(GitCoreLive),
    Layer.provide(ServerConfig.layerTest(root, { prefix: "bigbud-owner-workspace-api-" })),
    Layer.provide(NodeServices.layer),
  );
}

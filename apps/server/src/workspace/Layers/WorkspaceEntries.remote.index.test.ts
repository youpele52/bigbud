import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, vi } from "vitest";

import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import {
  WorkspaceIndexReadOwner,
  type WorkspaceIndexReadOwnerShape,
} from "../Services/WorkspaceIndexReadOwner.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const directSshTarget = "ssh:host=dev&transport=direct-ssh";
const cwd = "/srv/project ";
const owner = { indexWorkspace: vi.fn<WorkspaceIndexReadOwnerShape["indexWorkspace"]>() };
const baseLayer = WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive));
const withNodeServices = (layer: typeof baseLayer) =>
  layer.pipe(Layer.provideMerge(NodeServices.layer));

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

it.layer(
  withNodeServices(baseLayer.pipe(Layer.provide(Layer.succeed(WorkspaceIndexReadOwner, owner)))),
)("WorkspaceEntries with an index read owner", (it) => {
  it.effect(
    "captures the owner at layer construction and applies shared name ranking and limits",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", "agent");
        const entries = Object.freeze([
          Object.freeze({ path: "a/index-extra.ts", directory: false }),
          Object.freeze({ path: "z/index", directory: true }),
          Object.freeze({ path: "z/Index", directory: false }),
          Object.freeze({ path: "unmatched", directory: false }),
        ]);
        owner.indexWorkspace.mockResolvedValueOnce(Object.freeze({ entries, truncated: false }));
        const workspaceEntries = yield* WorkspaceEntries;
        const callTimeOwner = {
          indexWorkspace: vi.fn<WorkspaceIndexReadOwnerShape["indexWorkspace"]>(),
        };
        const result = yield* workspaceEntries
          .search({ cwd, executionTargetId: directSshTarget, query: "index", limit: 2 })
          .pipe(Effect.provideService(WorkspaceIndexReadOwner, callTimeOwner));
        expect(owner.indexWorkspace).toHaveBeenCalledExactlyOnceWith({
          cwd,
          executionTargetId: directSshTarget,
        });
        expect(callTimeOwner.indexWorkspace).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          entries: [
            { path: "z/index", kind: "directory", parentPath: "z" },
            { path: "z/Index", kind: "file", parentPath: "z" },
          ],
          truncated: true,
        });
      }),
  );

  it.effect(
    "drops malformed paths, applies the existing ignore rule, and preserves owner truncation",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", "direct-ssh");
        const literalPath = "src/a\tname\nwith space ";
        owner.indexWorkspace.mockResolvedValueOnce({
          entries: [
            { path: ".git", directory: true },
            { path: "node_modules/package/index.js", directory: false },
            { path: "src/dist/nested", directory: false },
            { path: literalPath, directory: false },
            ...[
              "",
              ".",
              "..",
              "./root",
              "/absolute",
              "a/../outside",
              "a\\..\\outside",
              "nul\0path",
              "a//b",
              "a/",
              "C:\\absolute",
              "\\\\unc\\share",
            ].map((path) => ({ path, directory: false })),
          ],
          truncated: true,
        });
        const workspaceEntries = yield* WorkspaceEntries;
        const result = yield* workspaceEntries.search({
          cwd,
          executionTargetId: "ssh:dev",
          query: "",
          limit: 100,
        });
        expect(owner.indexWorkspace).toHaveBeenCalledExactlyOnceWith({
          cwd,
          executionTargetId: "ssh:dev",
        });
        expect(result).toMatchObject({
          entries: [
            { path: literalPath, kind: "file", parentPath: "src" },
            { path: "src/dist/nested", kind: "file", parentPath: "src/dist" },
          ],
          truncated: true,
        });
      }),
  );

  it.effect("returns a typed owner failure without trying legacy SSH", () =>
    Effect.gen(function* () {
      const cause = new Error("owner unavailable");
      owner.indexWorkspace.mockRejectedValueOnce(cause);
      const workspaceEntries = yield* WorkspaceEntries;
      const error = yield* Effect.flip(
        workspaceEntries.search({ cwd, executionTargetId: directSshTarget, query: "", limit: 10 }),
      );
      expect(error).toMatchObject({
        _tag: "WorkspaceEntriesError",
        operation: "workspaceEntries.remoteIndex",
        detail: cause.message,
        cause,
      });
      expect(owner.indexWorkspace).toHaveBeenCalledTimes(1);
    }),
  );
});

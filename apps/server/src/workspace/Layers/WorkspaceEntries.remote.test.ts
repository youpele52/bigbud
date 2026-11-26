import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, vi } from "vitest";

import {
  WorkspaceDirectoryReadOwner,
  type WorkspaceDirectoryReadOwnerShape,
} from "../Services/WorkspaceDirectoryReadOwner.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const directSshTarget = "ssh:host=dev&transport=direct-ssh";
const cwd = "/srv/project ";
const owner = {
  listDirectory: vi.fn<WorkspaceDirectoryReadOwnerShape["listDirectory"]>(),
};
const baseLayer = WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive));
const withNodeServices = (layer: typeof baseLayer) =>
  layer.pipe(Layer.provideMerge(NodeServices.layer));

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

it.layer(
  withNodeServices(
    baseLayer.pipe(Layer.provide(Layer.succeed(WorkspaceDirectoryReadOwner, owner))),
  ),
)("WorkspaceEntries with a directory read owner", (it) => {
  it.effect(
    "captures the owner and keeps normalized paths, literal names, and legacy sorting",
    () =>
      Effect.gen(function* () {
        owner.listDirectory.mockResolvedValueOnce({
          entries: [
            { name: "a\tfile ", directory: false },
            { name: "z-dir", directory: true },
            { name: ".dot-dir", directory: true },
            { name: "", directory: false },
            { name: ".", directory: true },
            { name: "..", directory: true },
            { name: "a/not-a-child", directory: false },
            { name: "invalid\0name", directory: false },
          ],
          truncated: true,
        });
        const workspaceEntries = yield* WorkspaceEntries;
        const callTimeOwner = {
          listDirectory: vi.fn<WorkspaceDirectoryReadOwnerShape["listDirectory"]>(),
        };
        const result = yield* workspaceEntries
          .listDirectory({ cwd, executionTargetId: directSshTarget, relativePath: ".\\src //./" })
          .pipe(Effect.provideService(WorkspaceDirectoryReadOwner, callTimeOwner));

        expect(owner.listDirectory).toHaveBeenCalledExactlyOnceWith({
          cwd,
          executionTargetId: directSshTarget,
          relativeDir: "src ",
        });
        expect(callTimeOwner.listDirectory).not.toHaveBeenCalled();
        expect(result).toEqual({
          entries: [
            { path: "src /.dot-dir", kind: "directory", parentPath: "src " },
            { path: "src /z-dir", kind: "directory", parentPath: "src " },
            { path: "src /a\tfile ", kind: "file", parentPath: "src " },
          ],
        });
      }),
  );

  it.effect("uses the legacy direct SSH policy and filters ignored root entries", () =>
    Effect.gen(function* () {
      vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", "direct-ssh");
      owner.listDirectory.mockResolvedValueOnce({
        entries: [
          { name: ".git", directory: true },
          { name: "node_modules", directory: true },
          { name: "src", directory: true },
          { name: ".gitconfig", directory: false },
        ],
        truncated: false,
      });
      const workspaceEntries = yield* WorkspaceEntries;
      const result = yield* workspaceEntries.listDirectory({ cwd, executionTargetId: "ssh:dev" });
      expect(owner.listDirectory).toHaveBeenCalledExactlyOnceWith({
        cwd,
        executionTargetId: "ssh:dev",
        relativeDir: "",
      });
      expect(result.entries).toEqual([
        { path: "src", kind: "directory" },
        { path: ".gitconfig", kind: "file" },
      ]);
    }),
  );

  it.effect("rejects invalid relative paths before either transport is used", () =>
    Effect.gen(function* () {
      const workspaceEntries = yield* WorkspaceEntries;
      for (const relativePath of ["src\\..\\outside", "/absolute", "nul\0path"]) {
        const error = yield* Effect.flip(
          workspaceEntries.listDirectory({ cwd, executionTargetId: directSshTarget, relativePath }),
        );
        expect(error.operation).toBe("workspaceEntries.remoteDirectoryPath");
      }
      expect(owner.listDirectory).not.toHaveBeenCalled();
    }),
  );

  it.effect("returns a typed owner error without trying legacy SSH", () =>
    Effect.gen(function* () {
      const cause = new Error("owner unavailable");
      owner.listDirectory.mockRejectedValueOnce(cause);
      const workspaceEntries = yield* WorkspaceEntries;
      const error = yield* Effect.flip(
        workspaceEntries.listDirectory({ cwd, executionTargetId: directSshTarget }),
      );
      expect(error).toMatchObject({
        _tag: "WorkspaceEntriesError",
        operation: "workspaceEntries.remoteDirectory",
        detail: cause.message,
        cause,
      });
      expect(owner.listDirectory).toHaveBeenCalledTimes(1);
    }),
  );
});

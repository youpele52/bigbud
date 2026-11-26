import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { afterEach, beforeEach, vi } from "vitest";

import { runSshCommand } from "../../ssh/sshProcess.ts";
import {
  WorkspaceDirectoryReadOwner,
  type WorkspaceDirectoryReadOwnerShape,
} from "../Services/WorkspaceDirectoryReadOwner.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

vi.mock("../../ssh/sshProcess.ts", () => ({ runSshCommand: vi.fn() }));

const directSshTarget = "ssh:host=dev&transport=direct-ssh";
const agentTarget = "ssh:host=dev&transport=agent";
const cwd = "/srv/project ";
const owner = {
  listDirectory: vi.fn<WorkspaceDirectoryReadOwnerShape["listDirectory"]>(),
};
const baseLayer = WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive));
const withNodeServices = (layer: typeof baseLayer) =>
  layer.pipe(Layer.provideMerge(NodeServices.layer));

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

function mockLegacyListing(stdout: string, stdoutTruncated = false) {
  vi.mocked(runSshCommand).mockResolvedValueOnce({
    stdout,
    stdoutTruncated,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  });
}

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
        expect(runSshCommand).not.toHaveBeenCalled();
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
      expect(runSshCommand).not.toHaveBeenCalled();
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
      expect(runSshCommand).not.toHaveBeenCalled();
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
      expect(runSshCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not change local or agent-target listing", () =>
    Effect.gen(function* () {
      vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", "direct-ssh");
      mockLegacyListing("f\tagent-path\0");
      const workspaceEntries = yield* WorkspaceEntries;
      const fileSystem = yield* FileSystem.FileSystem;
      const localCwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${localCwd}/local-path`, "");

      expect(yield* workspaceEntries.listDirectory({ cwd: localCwd })).toEqual({
        entries: [{ path: "local-path", kind: "file" }],
      });
      expect(
        yield* workspaceEntries.listDirectory({ cwd, executionTargetId: agentTarget }),
      ).toEqual({
        entries: [{ path: "agent-path", kind: "file" }],
      });
      expect(runSshCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ cwd, executionTargetId: agentTarget, command: "find" }),
      );
      expect(owner.listDirectory).not.toHaveBeenCalled();
    }),
  );
});

it.layer(withNodeServices(baseLayer))("WorkspaceEntries without a directory read owner", (it) => {
  it.effect("preserves the legacy direct SSH command and truncated record handling", () =>
    Effect.gen(function* () {
      mockLegacyListing("f\tz.txt\0d\ta-dir\0f\tpartial", true);
      const workspaceEntries = yield* WorkspaceEntries;
      const result = yield* workspaceEntries.listDirectory({
        cwd,
        executionTargetId: directSshTarget,
        relativePath: "./src//",
      });
      expect(result.entries).toEqual([
        { path: "src/a-dir", kind: "directory", parentPath: "src" },
        { path: "src/z.txt", kind: "file", parentPath: "src" },
      ]);
      expect(runSshCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          cwd,
          executionTargetId: directSshTarget,
          command: "find",
          args: [
            "./src",
            "-mindepth",
            "1",
            "-maxdepth",
            "1",
            "(",
            "-type",
            "d",
            "-o",
            "-type",
            "f",
            ")",
            "-printf",
            "%y\\t%P\\0",
          ],
          outputMode: "truncate",
        }),
      );
    }),
  );
});

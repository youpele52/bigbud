import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { afterEach, beforeEach, vi } from "vitest";

import { runSshCommand } from "../../ssh/sshProcess.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import {
  WorkspaceIndexReadOwner,
  type WorkspaceIndexReadOwnerShape,
} from "../Services/WorkspaceIndexReadOwner.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

vi.mock("../../ssh/sshProcess.ts", () => ({ runSshCommand: vi.fn() }));

const directSshTarget = "ssh:host=dev&transport=direct-ssh";
const agentTarget = "ssh:host=dev&transport=agent";
const cwd = "/srv/project ";
const owner = { indexWorkspace: vi.fn<WorkspaceIndexReadOwnerShape["indexWorkspace"]>() };
const baseLayer = WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive));
const withNodeServices = (layer: typeof baseLayer) =>
  layer.pipe(Layer.provideMerge(NodeServices.layer));

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

function mockSshResponse(stdout: string) {
  vi.mocked(runSshCommand).mockResolvedValueOnce({
    stdout,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  });
}

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
        expect(runSshCommand).not.toHaveBeenCalled();
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
        expect(runSshCommand).not.toHaveBeenCalled();
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
      expect(runSshCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect("retains local and remote-agent search even when the owner is present", () =>
    Effect.gen(function* () {
      vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", "direct-ssh");
      mockSshResponse("true\n");
      mockSshResponse("agent-path\0");
      const workspaceEntries = yield* WorkspaceEntries;
      const fileSystem = yield* FileSystem.FileSystem;
      const localCwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${localCwd}/local-path`, "");

      expect(yield* workspaceEntries.search({ cwd: localCwd, query: "", limit: 10 })).toMatchObject(
        {
          entries: [{ path: "local-path", kind: "file" }],
          truncated: false,
        },
      );
      expect(
        yield* workspaceEntries.search({
          cwd,
          executionTargetId: agentTarget,
          query: "",
          limit: 10,
        }),
      ).toMatchObject({
        entries: [{ path: "agent-path", kind: "file" }],
        truncated: false,
      });
      expect(runSshCommand).toHaveBeenCalledTimes(2);
      expect(runSshCommand).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          cwd,
          executionTargetId: agentTarget,
          command: "git",
          args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        }),
      );
      expect(owner.indexWorkspace).not.toHaveBeenCalled();
    }),
  );
});

it.layer(withNodeServices(baseLayer))("WorkspaceEntries without an index read owner", (it) => {
  it.effect("retains the legacy direct SSH filesystem scan", () =>
    Effect.gen(function* () {
      mockSshResponse("false\n");
      mockSshResponse("d\tsrc\0f\tsrc/index.ts\0");
      const workspaceEntries = yield* WorkspaceEntries;
      const result = yield* workspaceEntries.search({
        cwd,
        executionTargetId: directSshTarget,
        query: "index",
        limit: 10,
      });
      expect(result).toMatchObject({
        entries: [{ path: "src/index.ts", kind: "file", parentPath: "src" }],
        truncated: false,
      });
      expect(runSshCommand).toHaveBeenCalledTimes(2);
      expect(runSshCommand).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          cwd,
          executionTargetId: directSshTarget,
          command: "find",
        }),
      );
    }),
  );
});

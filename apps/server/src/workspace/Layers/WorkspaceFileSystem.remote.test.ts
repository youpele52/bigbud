import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { beforeEach, vi } from "vitest";

import { ServerConfig } from "../../startup/config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import {
  WorkspaceFileReadOwner,
  type WorkspaceFileReadOwnerShape,
} from "../Services/WorkspaceFileReadOwner.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";
import { runToolCommand } from "../../tool-transport/toolTransport.ts";

vi.mock("../../tool-transport/toolTransport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tool-transport/toolTransport.ts")>()),
  runToolCommand: vi.fn(),
}));

const directSshTarget = "ssh:host=dev&transport=direct-ssh";
const agentTarget = "ssh:host=dev&transport=agent";
const owner = {
  readFilePreview: vi.fn<WorkspaceFileReadOwnerShape["readFilePreview"]>(),
  readFileRange: vi.fn<WorkspaceFileReadOwnerShape["readFileRange"]>(),
} satisfies WorkspaceFileReadOwnerShape;

const withTestDependencies = (layer: typeof WorkspaceFileSystemLive) =>
  layer.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(GitCoreLive),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "bigbud-workspace-files-remote-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

beforeEach(() => {
  vi.resetAllMocks();
});

const FallbackTestLayer = withTestDependencies(WorkspaceFileSystemLive);

it.layer(FallbackTestLayer)("WorkspaceFileSystem remote fallback", (it) => {
  describe("readFilePreview", () => {
    it.effect("reads a remote text file through the SSH tool transport", () =>
      Effect.gen(function* () {
        vi.mocked(runToolCommand).mockResolvedValue({
          stdout: "export const remote = true;\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
        });

        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const result = yield* workspaceFileSystem.readFilePreview({
          cwd: "/srv/project ",
          relativePath: "-file\t ",
          executionTargetId: directSshTarget,
        });

        expect(result).toEqual({
          relativePath: "-file\t ",
          contents: "export const remote = true;\n",
          sizeBytes: 28,
          truncated: false,
        });
        expect(runToolCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            target: {
              transport: "ssh",
              executionTargetId: directSshTarget,
              cwd: "/srv/project ",
            },
            command: "cat",
            args: ["--", "-file\t "],
            timeoutMs: 30_000,
          }),
        );
      }),
    );
  });

  describe("readFileRange", () => {
    it.effect("reads binary ranges through the SSH tool transport", () =>
      Effect.gen(function* () {
        vi.mocked(runToolCommand).mockResolvedValue({
          stdout: "8\nAQIDBAU=",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
        });

        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const result = yield* workspaceFileSystem.readFileRange({
          cwd: "/srv/project",
          relativePath: "assets/icon.bin",
          executionTargetId: directSshTarget,
          offset: 0,
          maxBytes: 5,
        });

        expect(result).toEqual({
          relativePath: "assets/icon.bin",
          bytes: new Uint8Array([1, 2, 3, 4, 5]),
          sizeBytes: 8,
          truncated: true,
        });
        expect(runToolCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            target: { transport: "ssh", executionTargetId: directSshTarget, cwd: "/srv/project" },
            command: "sh",
            args: expect.arrayContaining(["assets/icon.bin", "0", "5"]),
          }),
        );
      }),
    );
  });

  describe("searchFileContents", () => {
    it.effect("searches remote text through SSH ripgrep", () =>
      Effect.gen(function* () {
        vi.mocked(runToolCommand).mockResolvedValue({
          stdout: `${JSON.stringify({
            type: "match",
            data: {
              path: { text: "./src/index.ts" },
              line_number: 2,
              lines: { text: "const remote = true;\n" },
              submatches: [{ start: 6 }],
            },
          })}\n`,
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
        });

        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const result = yield* workspaceFileSystem.searchFileContents({
          cwd: "/srv/project",
          query: "remote",
          limit: 10,
          executionTargetId: directSshTarget,
        });

        expect(result).toEqual({
          matches: [
            {
              path: "src/index.ts",
              line: 2,
              column: 7,
              lineText: "const remote = true;",
            },
          ],
          truncated: false,
          notice: "use-managed-agent",
        });
        expect(runToolCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            command: "rg",
            args: expect.arrayContaining(["--ignore-case", "--fixed-strings"]),
            allowNonZeroExit: true,
          }),
        );
        expect(vi.mocked(runToolCommand).mock.lastCall?.[0].args).not.toContain("--smart-case");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("refuses create-only writes over SSH without running a command", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const failure = yield* workspaceFileSystem
          .writeFile({
            cwd: "/srv/project",
            relativePath: "settings.json",
            contents: "{}",
            executionTargetId: directSshTarget,
            createOnly: true,
          })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({
          operation: "workspaceFileSystem.writeFileCreateOnlyRemote",
          writeDisposition: "not-dispatched",
        });
        expect(runToolCommand).not.toHaveBeenCalled();
      }),
    );
  });
});

const OwnerTestLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(Layer.succeed(WorkspaceFileReadOwner, owner)),
  withTestDependencies,
);

it.layer(OwnerTestLayer)("WorkspaceFileSystem direct SSH read owner", (it) => {
  const input = {
    cwd: "/srv/project ",
    relativePath: "./sub/../-file\t ",
    executionTargetId: directSshTarget,
  };
  const ownerInput = { ...input, relativePath: "-file\t " };
  const preview = { contents: "owner", sizeBytes: 5, truncated: false };
  const range = { bytes: new Uint8Array([1]), sizeBytes: 5, truncated: true };

  it.effect("delegates resolved paths and bounded ranges exclusively to the owner", () =>
    Effect.gen(function* () {
      owner.readFilePreview.mockResolvedValueOnce(preview);
      owner.readFileRange.mockResolvedValueOnce(range);
      const workspaceFileSystem = yield* WorkspaceFileSystem;

      expect(yield* workspaceFileSystem.readFilePreview(input)).toEqual({
        relativePath: ownerInput.relativePath,
        ...preview,
      });
      expect(
        yield* workspaceFileSystem.readFileRange({ ...input, offset: 1.75, maxBytes: 900_000 }),
      ).toEqual({ relativePath: ownerInput.relativePath, ...range });
      expect(owner.readFilePreview).toHaveBeenCalledExactlyOnceWith(ownerInput);
      expect(owner.readFileRange).toHaveBeenCalledExactlyOnceWith({
        ...ownerInput,
        offset: 1,
        maxBytes: 512 * 1024,
      });
      expect(runToolCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect("fails closed when the owner rejects a preview or range", () =>
    Effect.gen(function* () {
      const cause = new Error("Owner read denied");
      owner.readFilePreview.mockRejectedValueOnce(cause);
      owner.readFileRange.mockRejectedValueOnce(cause);
      const workspaceFileSystem = yield* WorkspaceFileSystem;

      const previewFailure = yield* workspaceFileSystem.readFilePreview(input).pipe(Effect.flip);
      const rangeFailure = yield* workspaceFileSystem
        .readFileRange({ ...input, offset: 0, maxBytes: 1 })
        .pipe(Effect.flip);
      expect(previewFailure).toMatchObject({
        _tag: "WorkspaceFileSystemError",
        operation: "workspaceFileSystem.readFilePreviewRemote",
        detail: cause.message,
        cause,
      });
      expect(rangeFailure).toMatchObject({
        _tag: "WorkspaceFileSystemError",
        operation: "workspaceFileSystem.readFileRangeRemote",
        detail: cause.message,
        cause,
      });
      expect(runToolCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects paths outside the workspace before dispatching either read", () =>
    Effect.gen(function* () {
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const outside = { ...input, relativePath: "../outside" };
      const previewFailure = yield* workspaceFileSystem.readFilePreview(outside).pipe(Effect.flip);
      const rangeFailure = yield* workspaceFileSystem
        .readFileRange({ ...outside, offset: 0, maxBytes: 1 })
        .pipe(Effect.flip);
      expect(previewFailure._tag).toBe("WorkspacePathOutsideRootError");
      expect(rangeFailure._tag).toBe("WorkspacePathOutsideRootError");
      expect(owner.readFilePreview).not.toHaveBeenCalled();
      expect(owner.readFileRange).not.toHaveBeenCalled();
      expect(runToolCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps agent and local reads on their existing paths even with an owner", () =>
    Effect.gen(function* () {
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "local");
      const localInput = { cwd, relativePath: "file.txt" };
      expect(yield* workspaceFileSystem.readFilePreview(localInput)).toMatchObject({
        contents: "local",
      });
      expect(
        yield* workspaceFileSystem.readFileRange({ ...localInput, offset: 0, maxBytes: 1 }),
      ).toMatchObject({ bytes: new Uint8Array([108]) });
      expect(runToolCommand).not.toHaveBeenCalled();

      const agent = { ...input, executionTargetId: agentTarget };
      const commandResult = {
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
        stdoutTruncated: false,
      };
      vi.mocked(runToolCommand)
        .mockResolvedValueOnce({ ...commandResult, stdout: "agent" })
        .mockResolvedValueOnce({ ...commandResult, stdout: "5\nAQ==" });
      expect(yield* workspaceFileSystem.readFilePreview(agent)).toMatchObject({
        contents: "agent",
      });
      expect(
        yield* workspaceFileSystem.readFileRange({ ...agent, offset: 0, maxBytes: 1 }),
      ).toMatchObject(range);
      const toolTarget = { transport: "agent", executionTargetId: agentTarget, cwd: agent.cwd };
      expect(runToolCommand).toHaveBeenCalledTimes(2);
      expect(runToolCommand).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ target: toolTarget, command: "cat" }),
      );
      expect(runToolCommand).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ target: toolTarget, command: "sh" }),
      );
      expect(owner.readFilePreview).not.toHaveBeenCalled();
      expect(owner.readFileRange).not.toHaveBeenCalled();
    }),
  );
});

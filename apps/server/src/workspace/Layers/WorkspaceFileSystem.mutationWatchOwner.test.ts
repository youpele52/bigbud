import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { beforeEach, vi } from "vitest";

import { runToolCommand } from "../../tool-transport/toolTransport.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import {
  WorkspaceMutationWatchOwner,
  type WorkspaceMutationWatchOwnerShape,
} from "../Services/WorkspaceMutationWatchOwner.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

vi.mock("../../tool-transport/toolTransport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tool-transport/toolTransport.ts")>()),
  runToolCommand: vi.fn(),
}));

const owner = {
  snapshotDirectory: vi.fn<WorkspaceMutationWatchOwnerShape["snapshotDirectory"]>(),
  writeFile: vi.fn<WorkspaceMutationWatchOwnerShape["writeFile"]>(),
  maxWriteBytes: 16,
} satisfies WorkspaceMutationWatchOwnerShape;
const invalidate = vi.fn((_: string) => Effect.void);
const dependencies = Layer.mergeAll(
  WorkspacePathsLive,
  Layer.succeed(WorkspaceEntries, {
    invalidate,
    listDirectory: () => Effect.die("Unexpected directory listing"),
    search: () => Effect.die("Unexpected entry search"),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
const FallbackTestLayer = WorkspaceFileSystemLive.pipe(Layer.provide(dependencies));
const OwnerTestLayer = FallbackTestLayer.pipe(
  Layer.provide(Layer.succeed(WorkspaceMutationWatchOwner, owner)),
);

const target = { cwd: "/srv/project ", executionTargetId: "ssh:host=dev&transport=direct-ssh" };
const writeInput = { ...target, relativePath: "./src/../-file\t ", contents: "text\n" };

beforeEach(() => {
  vi.resetAllMocks();
});

it.layer(OwnerTestLayer)("WorkspaceFileSystem direct SSH mutation and watch owner", (it) => {
  it.effect(
    "writes normalized relative paths exclusively through the owner and invalidates after success",
    () =>
      Effect.gen(function* () {
        owner.writeFile.mockImplementationOnce(async () => {
          expect(invalidate).not.toHaveBeenCalled();
        });
        const workspace = yield* WorkspaceFileSystem;
        const result = yield* workspace.writeFile(writeInput);

        expect(result).toEqual({ relativePath: "-file\t " });
        expect(owner.writeFile).toHaveBeenCalledExactlyOnceWith({
          ...writeInput,
          relativePath: result.relativePath,
        });
        expect(invalidate).toHaveBeenCalledExactlyOnceWith(target.cwd);
        expect(runToolCommand).not.toHaveBeenCalled();
      }),
  );

  it.effect("reports a rejected owner write as unknown without retrying or invalidating", () =>
    Effect.gen(function* () {
      const cause = new Error("connection lost after dispatch");
      owner.writeFile.mockRejectedValueOnce(cause);
      const workspace = yield* WorkspaceFileSystem;
      const failure = yield* workspace.writeFile(writeInput).pipe(Effect.flip);

      expect(failure).toMatchObject({
        operation: "workspaceFileSystem.writeFileRemote",
        writeDisposition: "unknown",
        detail: cause.message,
        cause,
      });
      expect(owner.writeFile).toHaveBeenCalledTimes(1);
      expect(runToolCommand).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    }),
  );

  it.effect("refuses a body above the owner limit before dispatch", () =>
    Effect.gen(function* () {
      const workspace = yield* WorkspaceFileSystem;
      // 16 bytes is the owner bound; "é" is two UTF-8 bytes, so 9 of them exceed it.
      const failure = yield* workspace
        .writeFile({ ...writeInput, contents: "é".repeat(9) })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        operation: "workspaceFileSystem.writeFileRemote",
        writeDisposition: "not-dispatched",
      });
      expect(owner.writeFile).not.toHaveBeenCalled();
      expect(yield* workspace.writeFile({ ...writeInput, contents: "é".repeat(8) })).toEqual({
        relativePath: "-file\t ",
      });
    }),
  );

  it.effect("rejects create-only and conditional writes before either remote dispatch", () =>
    Effect.gen(function* () {
      const workspace = yield* WorkspaceFileSystem;
      const createOnly = yield* workspace
        .writeFile({ ...writeInput, createOnly: true })
        .pipe(Effect.flip);
      const expectedHash = yield* workspace
        .writeFile({ ...writeInput, expectedSha256: "a".repeat(64) })
        .pipe(Effect.flip);

      expect(createOnly).toMatchObject({
        operation: "workspaceFileSystem.writeFileCreateOnlyRemote",
        writeDisposition: "not-dispatched",
      });
      expect(expectedHash).toMatchObject({
        operation: "workspaceFileSystem.writeFileExpectedHashRemote",
        writeDisposition: "not-dispatched",
      });
      expect(owner.writeFile).not.toHaveBeenCalled();
      expect(runToolCommand).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    }),
  );

  it.effect("uses a lazy owner snapshot for the normalized watched directory", () =>
    Effect.gen(function* () {
      owner.snapshotDirectory.mockResolvedValueOnce("snapshot");
      const workspace = yield* WorkspaceFileSystem;
      const stream = yield* workspace.watchDirectory({ ...target, relativePath: "./src/../docs" });
      expect(owner.snapshotDirectory).not.toHaveBeenCalled();

      const event = yield* Stream.runHead(stream);
      expect(Option.getOrUndefined(event)).toEqual({
        version: 1,
        type: "directoryChanged",
        relativePath: "docs",
        generation: 1,
        backend: "directSshPoll",
      });
      expect(owner.snapshotDirectory).toHaveBeenCalledExactlyOnceWith(
        { ...target, relativePath: "docs" },
        expect.any(AbortSignal),
      );
    }),
  );

  it.effect("reports a lost owner snapshot without falling back to SSH find", () =>
    Effect.gen(function* () {
      owner.snapshotDirectory.mockRejectedValueOnce(new Error("connection lost"));
      const workspace = yield* WorkspaceFileSystem;
      const stream = yield* workspace.watchDirectory(target);
      const event = yield* Stream.runHead(stream);

      expect(Option.getOrUndefined(event)).toEqual({
        version: 1,
        type: "rescanRequired",
        relativePath: "",
        generation: 1,
        backend: "directSshPoll",
        reason: "transportLost",
      });
      expect(owner.snapshotDirectory).toHaveBeenCalledExactlyOnceWith(
        { ...target, relativePath: "" },
        expect.any(AbortSignal),
      );
    }),
  );
});

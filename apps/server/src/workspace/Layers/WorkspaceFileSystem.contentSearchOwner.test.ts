import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { beforeEach, vi } from "vitest";

import { runToolCommand } from "../../tool-transport/toolTransport.ts";
import {
  WorkspaceContentSearchOwner,
  type WorkspaceContentSearchOwnerShape,
} from "../Services/WorkspaceContentSearchOwner.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem, WorkspaceFileSystemError } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

vi.mock("../../tool-transport/toolTransport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tool-transport/toolTransport.ts")>()),
  runToolCommand: vi.fn(),
}));

const searchFileContents = vi.fn<WorkspaceContentSearchOwnerShape["searchFileContents"]>();
const dependencies = Layer.mergeAll(
  WorkspacePathsLive,
  Layer.succeed(WorkspaceEntries, {
    invalidate: () => Effect.void,
    listDirectory: () => Effect.die("Unexpected directory listing"),
    search: () => Effect.die("Unexpected entry search"),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
const TestLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(Layer.succeed(WorkspaceContentSearchOwner, { searchFileContents })),
  Layer.provide(dependencies),
);

const input = {
  executionTargetId: "ssh:host=dev&transport=direct-ssh",
  cwd: "/srv/project ",
  query: "a.b(",
  limit: 1,
};
const match = { path: "src/example.ts", line: 2, column: 3, lineText: "  a.b(" };

beforeEach(() => {
  vi.resetAllMocks();
});

it.layer(TestLayer)("WorkspaceFileSystem direct SSH content search owner", (it) => {
  it.effect("dispatches the exact input to the owner and caps the returned matches", () =>
    Effect.gen(function* () {
      searchFileContents.mockResolvedValueOnce({
        matches: [match, { ...match, line: 4 }],
        truncated: false,
        notice: "use-managed-agent",
      });
      const workspace = yield* WorkspaceFileSystem;

      expect(yield* workspace.searchFileContents(input)).toEqual({
        matches: [match],
        truncated: true,
        notice: "use-managed-agent",
      });
      expect(searchFileContents).toHaveBeenCalledExactlyOnceWith(input);
      expect(runToolCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "preserves owner truncation even when fewer than the requested matches are returned",
    () =>
      Effect.gen(function* () {
        searchFileContents.mockResolvedValueOnce({ matches: [match], truncated: true });
        const workspace = yield* WorkspaceFileSystem;

        expect(yield* workspace.searchFileContents({ ...input, limit: 2 })).toEqual({
          matches: [match],
          truncated: true,
        });
        expect(runToolCommand).not.toHaveBeenCalled();
      }),
  );

  it.effect("returns typed failures for an unavailable owner or missing rg without fallback", () =>
    Effect.gen(function* () {
      const unavailable = new Error("SSH owner unavailable");
      const missingRipgrep = new Error("Command not found: rg");
      searchFileContents.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(missingRipgrep);
      const workspace = yield* WorkspaceFileSystem;

      const unavailableFailure = yield* workspace.searchFileContents(input).pipe(Effect.flip);
      expect(unavailableFailure).toBeInstanceOf(WorkspaceFileSystemError);
      expect(unavailableFailure).toMatchObject({
        operation: "workspaceFileSystem.searchFileContentsRemote",
        detail: unavailable.message,
        cause: unavailable,
      });
      const missingRipgrepFailure = yield* workspace.searchFileContents(input).pipe(Effect.flip);
      expect(missingRipgrepFailure).toBeInstanceOf(WorkspaceFileSystemError);
      expect(missingRipgrepFailure).toMatchObject({
        operation: "workspaceFileSystem.searchFileContentsRemote",
        detail: "Remote content search requires ripgrep on the SSH host, or the bigbud agent.",
        cause: missingRipgrep,
      });
      expect(searchFileContents).toHaveBeenCalledTimes(2);
      expect(runToolCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects local searches and unsafe roots before dispatch", () =>
    Effect.gen(function* () {
      const workspace = yield* WorkspaceFileSystem;
      const local = yield* workspace
        .searchFileContents({ cwd: input.cwd, query: input.query, limit: input.limit })
        .pipe(Effect.flip);
      expect(local).toMatchObject({
        operation: "workspaceFileSystem.searchFileContents",
        detail: "Local content search is owned by the local workspace agent.",
        retryable: false,
      });
      const unsafe = yield* workspace
        .searchFileContents({ ...input, cwd: "/srv/bad\0path" })
        .pipe(Effect.flip);
      expect(unsafe).toMatchObject({
        operation: "workspaceFileSystem.searchFileContents",
        detail: "Workspace root cannot contain NUL bytes.",
      });
      expect(searchFileContents).not.toHaveBeenCalled();
      expect(runToolCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps remote-agent targets on the existing tool transport and accepts exit 1", () =>
    Effect.gen(function* () {
      const executionTargetId = "ssh:host=dev&transport=agent";
      vi.mocked(runToolCommand).mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 1,
        signal: null,
        timedOut: false,
        stdoutTruncated: false,
      });
      const workspace = yield* WorkspaceFileSystem;
      const result = yield* workspace.searchFileContents({ ...input, executionTargetId });

      expect(result).toEqual({ matches: [], truncated: false, notice: "use-managed-agent" });
      expect(searchFileContents).not.toHaveBeenCalled();
      expect(runToolCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          target: { executionTargetId, cwd: input.cwd, transport: "agent" },
          command: "rg",
          args: expect.arrayContaining([
            "--ignore-case",
            "--fixed-strings",
            "--",
            input.query,
            ".",
          ]),
          allowNonZeroExit: true,
          timeoutMs: 10_000,
          maxBufferBytes: 512 * 1024,
          outputMode: "truncate",
        }),
      );
    }),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { ServerConfig } from "../../startup/config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";
import { runToolCommand } from "../../tool-transport/toolTransport.ts";

vi.mock("../../tool-transport/toolTransport.ts", () => ({
  resolveToolTransportTarget: (target: unknown) => target,
  runToolCommand: vi.fn(),
}));

const TestLayer = WorkspaceFileSystemLive.pipe(
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

it.layer(TestLayer)("WorkspaceFileSystem remote fallback", (it) => {
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
          cwd: "/srv/project",
          relativePath: "src/index.ts",
          executionTargetId: "ssh:dev",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const remote = true;\n",
          sizeBytes: 28,
          truncated: false,
        });
        expect(runToolCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            command: "cat",
            args: ["src/index.ts"],
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
          executionTargetId: "ssh:dev",
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
          executionTargetId: "ssh:dev",
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
        });
        expect(runToolCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            command: "rg",
            allowNonZeroExit: true,
          }),
        );
      }),
    );
  });
});

import { win32 } from "node:path";
import fsPromises from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { afterEach, vi } from "vitest";
import { makeWorkspacePaths } from "./WorkspacePaths.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { makeWorkspaceEntries } from "./WorkspaceEntries.ts";
import { runSshCommand } from "../../ssh/sshProcess.ts";

vi.mock("../../ssh/sshProcess.ts", () => ({ runSshCommand: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.layer(NodeServices.layer)("Windows directory identity guards", (it) => {
  it.effect("rejects unsafe roots before stat, including segments normalization would erase", () =>
    Effect.gen(function* () {
      const hostPath = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const stat = vi.fn(fs.stat);
      const paths = yield* makeWorkspacePaths.pipe(
        Effect.provideService(Path.Path, { ...hostPath, ...win32 }),
        Effect.provideService(FileSystem.FileSystem, { ...fs, stat }),
      );
      for (const root of [
        "C:\\workspace ",
        "C:\\workspace.",
        "C:\\alias \\..\\safe",
        "~\\alias \\..\\safe",
        "~/alias /../safe",
      ]) {
        const error = yield* paths.normalizeWorkspaceRoot(root).pipe(Effect.flip);
        expect(error._tag).toBe("WorkspaceRootInvalidError");
      }
      expect(stat).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects unsafe local listings before readdir but permits exact remote names", () =>
    Effect.gen(function* () {
      const hostPath = yield* Path.Path;
      const windowsPath = { ...hostPath, ...win32 };
      const paths = yield* makeWorkspacePaths.pipe(Effect.provideService(Path.Path, windowsPath));
      const readdir = vi.spyOn(fsPromises, "readdir");
      const entries = yield* makeWorkspaceEntries.pipe(
        Effect.provideService(Path.Path, windowsPath),
        Effect.provideService(WorkspacePaths, {
          ...paths,
          normalizeWorkspaceRoot: (cwd) => Effect.succeed(cwd),
        }),
      );
      for (const relativePath of ["folder ", "folder.", "folder /../safe"]) {
        const error = yield* entries
          .listDirectory({ cwd: "C:\\workspace", relativePath })
          .pipe(Effect.flip);
        expect(error.operation).toBe("workspaceEntries.validateDirectoryPath");
      }
      expect(readdir).not.toHaveBeenCalled();
      vi.mocked(runSshCommand).mockResolvedValueOnce({
        stdout: "f\tfile\t \0",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const remote = yield* entries.listDirectory({
        cwd: "/srv/workspace ",
        relativePath: "folder ",
        executionTargetId: "ssh:dev",
      });
      expect(remote.entries).toEqual([
        { path: "folder /file\t ", parentPath: "folder ", kind: "file" },
      ]);
      expect(readdir).not.toHaveBeenCalled();
    }),
  );
});

import { win32 } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { afterEach, vi } from "vitest";
import { makeWorkspacePaths } from "./WorkspacePaths.ts";

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
});

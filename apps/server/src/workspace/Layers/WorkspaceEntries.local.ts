import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";

import { Effect, type Path } from "effect";

import { WorkspaceEntriesError } from "../Services/WorkspaceEntries.ts";
import { processErrorDetail } from "./WorkspaceEntries.constants.ts";
import { validateLocalDirectoryPath } from "./WorkspaceEntries.paths.ts";

export const readLocalDirectoryEntries = Effect.fn("WorkspaceEntries.readDirectoryEntries")(
  function* (
    path: Path.Path,
    cwd: string,
    relativeDir: string,
  ): Effect.fn.Return<
    { readonly relativeDir: string; readonly dirents: Dirent[] | null },
    WorkspaceEntriesError
  > {
    yield* validateLocalDirectoryPath(cwd, relativeDir, path.sep);
    return yield* Effect.tryPromise({
      try: async () => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        const dirents = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
        return { relativeDir, dirents };
      },
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd,
          operation: "workspaceEntries.readDirectoryEntries",
          detail: processErrorDetail(cause),
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        () => relativeDir.length > 0,
        () => Effect.succeed({ relativeDir, dirents: null }),
      ),
    );
  },
);

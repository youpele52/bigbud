import { Effect } from "effect";
import { WorkspaceEntriesError } from "../Services/WorkspaceEntries.ts";
import { hasWindowsPathAlias } from "./WorkspacePaths.windows.ts";

/** Validate before joining paths or recovering from nested-directory I/O failures. */
export const validateLocalDirectoryPath = Effect.fn("validateLocalDirectoryPath")(function* (
  cwd: string,
  relativeDir: string,
  separator: string,
) {
  if (separator === "\\" && (hasWindowsPathAlias(cwd) || hasWindowsPathAlias(relativeDir))) {
    return yield* new WorkspaceEntriesError({
      cwd,
      operation: "workspaceEntries.validateDirectoryPath",
      detail: "Windows directory path segments cannot end in spaces or dots.",
    });
  }
});

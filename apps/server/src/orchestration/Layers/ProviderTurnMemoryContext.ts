import { Effect, FileSystem, Path } from "effect";

import { resolveMemoryDocumentPath } from "../../learning/Layers/MemoryStore.ts";

export const readProviderMemoryContext = Effect.fn("readProviderMemoryContext")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly projectId: string;
}) {
  const documents = yield* Effect.forEach(["user", "global", "project"] as const, (scope) => {
    const documentPath = resolveMemoryDocumentPath({
      path: input.path,
      stateDir: input.stateDir,
      scope,
      projectId: scope === "project" ? input.projectId : null,
    });
    return documentPath
      ? input.fileSystem.readFileString(documentPath).pipe(Effect.orElseSucceed(() => ""))
      : Effect.succeed("");
  });
  return documents
    .filter((document) => document.trim().length > 0)
    .join("\n\n")
    .slice(0, 12_000);
});

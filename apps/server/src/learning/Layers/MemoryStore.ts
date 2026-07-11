import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../startup/config.ts";
import {
  MemoryConflictError,
  MemoryStore,
  MemoryStoreError,
  type MemoryStoreShape,
} from "../Services/MemoryStore.ts";

const memoryFileName = (scope: "user" | "global" | "project") =>
  scope === "user" ? "USER.md" : "MEMORY.md";

export function resolveProjectMemoryDirectoryPath(input: {
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly projectId: string;
}): string | null {
  if (
    input.projectId.length === 0 ||
    input.projectId === "." ||
    input.projectId === ".." ||
    input.projectId.includes("/") ||
    input.projectId.includes("\\")
  ) {
    return null;
  }
  return input.path.join(input.stateDir, "memory", "projects", input.projectId);
}

export function resolveMemoryDocumentPath(input: {
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly scope: "user" | "global" | "project";
  readonly projectId: string | null;
}): string | null {
  if (input.scope === "project") {
    if (!input.projectId) return null;
    const projectDirectory = resolveProjectMemoryDirectoryPath({
      path: input.path,
      stateDir: input.stateDir,
      projectId: input.projectId,
    });
    return projectDirectory ? input.path.join(projectDirectory, memoryFileName(input.scope)) : null;
  }
  return input.path.join(input.stateDir, "memory", input.scope, memoryFileName(input.scope));
}

const makeMemoryStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const resolvePath = (scope: "user" | "global" | "project", projectId: string | null) =>
    resolveMemoryDocumentPath({ path, stateDir: config.stateDir, scope, projectId });

  const read: MemoryStoreShape["read"] = Effect.fn("MemoryStore.read")(function* (input) {
    const documentPath = resolvePath(input.scope, input.projectId);
    if (!documentPath) {
      return yield* new MemoryStoreError({ operation: "read.projectScopeRequiresProjectId" });
    }
    const content = yield* fs.readFileString(documentPath).pipe(Effect.orElseSucceed(() => ""));
    const stat = yield* fs.stat(documentPath).pipe(Effect.orElseSucceed(() => null));
    return {
      scope: input.scope,
      projectId: input.projectId,
      content,
      updatedAt: stat?.mtime instanceof Date ? stat.mtime.toISOString() : new Date(0).toISOString(),
    };
  });

  const write: MemoryStoreShape["write"] = Effect.fn("MemoryStore.write")(function* (input) {
    const documentPath = resolvePath(input.scope, input.projectId);
    if (!documentPath) {
      return yield* new MemoryStoreError({ operation: "write.projectScopeRequiresProjectId" });
    }
    const current = yield* fs.readFileString(documentPath).pipe(Effect.orElseSucceed(() => ""));
    if (input.expectedContent !== undefined && current !== input.expectedContent) {
      return yield* new MemoryConflictError({ scope: input.scope, projectId: input.projectId });
    }
    yield* fs
      .makeDirectory(path.dirname(documentPath), { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new MemoryStoreError({ operation: "write.makeDirectory", cause }),
        ),
      );
    const temporaryPath = `${documentPath}.${crypto.randomUUID()}.tmp`;
    yield* fs
      .writeFileString(temporaryPath, input.content)
      .pipe(
        Effect.mapError(
          (cause) => new MemoryStoreError({ operation: "write.writeTemporary", cause }),
        ),
      );
    yield* fs
      .rename(temporaryPath, documentPath)
      .pipe(
        Effect.mapError(
          (cause) => new MemoryStoreError({ operation: "write.renameTemporary", cause }),
        ),
      );
    return yield* read({ scope: input.scope, projectId: input.projectId });
  });

  return { read, write } satisfies MemoryStoreShape;
});

export const MemoryStoreLive = Layer.effect(MemoryStore, makeMemoryStore);

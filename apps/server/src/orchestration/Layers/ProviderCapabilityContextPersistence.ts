import { createHash } from "node:crypto";

import { Cause, Effect, FileSystem, Path } from "effect";

import type { ProviderCapabilityContextState } from "./ProviderCommandReactorSessionOps.capabilityContext.ts";

const stateFileName = (threadId: string): string =>
  `${createHash("sha256").update(threadId).digest("hex").slice(0, 32)}.json`;

const decodeState = (value: unknown): ProviderCapabilityContextState | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.finalizedHumanPromptCount !== "number" ||
    typeof record.hasObservedMcpStatus !== "boolean" ||
    typeof record.needsLp !== "boolean"
  ) {
    return null;
  }
  const nullableString = (key: string): string | null | undefined => {
    const entry = record[key];
    return entry === null || typeof entry === "string" ? entry : undefined;
  };
  const lastCatalogRevision = nullableString("lastCatalogRevision");
  const lastCompactionActivityId = nullableString("lastCompactionActivityId");
  const lastMcpStatusActivityId = nullableString("lastMcpStatusActivityId");
  const lastMemoryHash = nullableString("lastMemoryHash");
  const lastAgentBrowserPreference =
    record.lastAgentBrowserPreference === "bigbud" || record.lastAgentBrowserPreference === "system"
      ? record.lastAgentBrowserPreference
      : null;
  if (
    lastCatalogRevision === undefined ||
    lastCompactionActivityId === undefined ||
    lastMcpStatusActivityId === undefined ||
    lastMemoryHash === undefined
  ) {
    return null;
  }
  return {
    finalizedHumanPromptCount: Math.max(0, Math.trunc(record.finalizedHumanPromptCount)),
    hasObservedMcpStatus: record.hasObservedMcpStatus,
    lastCatalogRevision,
    lastCompactionActivityId,
    lastMcpStatusActivityId,
    lastMemoryHash,
    lastAgentBrowserPreference,
    needsLp: record.needsLp,
  };
};

const resolvePaths = (path: Path.Path, stateDir: string, threadId: string) => {
  const directory = path.join(stateDir, "capability-context");
  const file = path.join(directory, stateFileName(threadId));
  return { directory, file, temporaryFile: `${file}.tmp` };
};

export const loadProviderCapabilityContextState = Effect.fn("loadProviderCapabilityContextState")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly stateDir: string;
    readonly threadId: string;
  }) {
    const { file } = resolvePaths(input.path, input.stateDir, input.threadId);
    const text = yield* input.fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    if (text.length === 0) return null;
    return yield* Effect.try({
      try: () => decodeState(JSON.parse(text)),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
  },
);

export const persistProviderCapabilityContextState = Effect.fn(
  "persistProviderCapabilityContextState",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly threadId: string;
  readonly state: ProviderCapabilityContextState;
}) {
  const paths = resolvePaths(input.path, input.stateDir, input.threadId);
  yield* input.fileSystem.makeDirectory(paths.directory, { recursive: true });
  yield* input.fileSystem.writeFileString(paths.temporaryFile, `${JSON.stringify(input.state)}\n`);
  yield* input.fileSystem.rename(paths.temporaryFile, paths.file);
});

export const restoreProviderCapabilityContextState = Effect.fn(
  "restoreProviderCapabilityContextState",
)(function* (input: {
  readonly states: Map<string, ProviderCapabilityContextState>;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly threadId: string;
}) {
  if (input.states.has(input.threadId)) return;
  yield* loadProviderCapabilityContextState(input).pipe(
    Effect.map((state) => {
      if (state) input.states.set(input.threadId, state);
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to restore capability context state", {
        threadId: input.threadId,
        cause: Cause.pretty(cause),
      }),
    ),
  );
});

export const saveProviderCapabilityContextState = Effect.fn("saveProviderCapabilityContextState")(
  function* (input: {
    readonly states: Map<string, ProviderCapabilityContextState>;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly stateDir: string;
    readonly threadId: string;
  }) {
    const state = input.states.get(input.threadId);
    if (!state) return;
    yield* persistProviderCapabilityContextState({ ...input, state }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to persist capability context state", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  },
);

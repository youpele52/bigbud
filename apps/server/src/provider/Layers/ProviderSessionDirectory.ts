import { type ProviderKind, type ThreadId } from "@bigbud/contracts";
import { Effect, Layer, Option, Semaphore } from "effect";
import { CODEX_REWIND_KEY, hasCodexRewindMarker } from "../Services/ProviderRewind.ts";
import {
  hasPendingInspectionTerminal,
  INSPECTION_TERMINAL_KEY,
} from "../Services/ProviderInspectionTerminal.ts";
import { makeDirectoryInspection } from "./ProviderSessionDirectory.inspection.ts";
import { makeDirectoryCompaction } from "./ProviderSessionDirectory.compaction.ts";
import { CODEX_COMPACTIONS_KEY } from "../Services/ProviderCompaction.ts";

import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import type { ProviderSessionRuntime } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError, ProviderValidationError } from "../Errors.ts";
import { resolveProviderSessionExecutionTargets } from "../providerSessionExecutionTargets.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

function decodeProviderKind(
  providerName: string,
  _operation: string,
): Effect.Effect<ProviderKind, ProviderSessionDirectoryPersistenceError> {
  // Persisted bindings are an inventory of historical provider state, not a
  // declaration that the current build can route it. Preserve unknown names
  // so startup and read paths remain lossless; ProviderService rejects them
  // later when it checks the live adapter registry.
  return Effect.succeed(providerName as ProviderKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    const {
      [CODEX_REWIND_KEY]: _reserved,
      [INSPECTION_TERMINAL_KEY]: _journal,
      [CODEX_COMPACTIONS_KEY]: _compactions,
      ...ordinary
    } = next;
    return { ...existing, ...ordinary };
  }
  if (hasCodexRewindMarker(existing) || hasPendingInspectionTerminal(existing)) return existing;
  return next;
}

const toRuntimeBinding = (
  value: ProviderSessionRuntime,
  provider: ProviderKind,
): ProviderRuntimeBinding => {
  const executionTargets = resolveProviderSessionExecutionTargets({
    providerRuntimeExecutionTargetId: value.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: value.workspaceExecutionTargetId,
    executionTargetId: value.executionTargetId,
  });
  return {
    threadId: value.threadId,
    provider,
    providerRuntimeExecutionTargetId: executionTargets.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: executionTargets.workspaceExecutionTargetId,
    executionTargetId: executionTargets.executionTargetId,
    adapterKey: value.adapterKey,
    runtimeMode: value.runtimeMode,
    status: value.status,
    lastSeenAt: value.lastSeenAt,
    resumeCursor: value.resumeCursor,
    runtimePayload: value.runtimePayload,
  };
};

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntimeRepository;
  // Covers the entire read/merge/write, not just individual repository calls.
  const writes = yield* Semaphore.make(1);

  const getBinding = (threadId: ThreadId) =>
    repository.getByThreadId({ threadId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getByThreadId")),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
          onSome: (value) =>
            decodeProviderKind(value.providerName, "ProviderSessionDirectory.getBinding").pipe(
              Effect.map((provider) => Option.some(toRuntimeBinding(value, provider))),
            ),
        }),
      ),
    );

  const upsert: ProviderSessionDirectoryShape["upsert"] = Effect.fn(function* (binding) {
    const existing = yield* repository
      .getByThreadId({ threadId: binding.threadId })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getByThreadId")));

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
    if (!resolvedThreadId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "threadId must be a non-empty string.",
      });
    }

    const now = new Date().toISOString();
    const providerChanged =
      existingRuntime !== undefined && existingRuntime.providerName !== binding.provider;
    const executionTargets = resolveProviderSessionExecutionTargets({
      providerRuntimeExecutionTargetId:
        binding.providerRuntimeExecutionTargetId ??
        existingRuntime?.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId:
        binding.workspaceExecutionTargetId ?? existingRuntime?.workspaceExecutionTargetId,
      executionTargetId: binding.executionTargetId ?? existingRuntime?.executionTargetId,
    });
    yield* repository
      .upsert({
        threadId: resolvedThreadId,
        providerName: binding.provider,
        adapterKey:
          binding.adapterKey ??
          (providerChanged ? binding.provider : (existingRuntime?.adapterKey ?? binding.provider)),
        providerRuntimeExecutionTargetId: executionTargets.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: executionTargets.workspaceExecutionTargetId,
        executionTargetId: executionTargets.executionTargetId,
        runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
        status: binding.status ?? existingRuntime?.status ?? "running",
        lastSeenAt: now,
        resumeCursor:
          binding.resumeCursor !== undefined
            ? binding.resumeCursor
            : (existingRuntime?.resumeCursor ?? null),
        runtimePayload: mergeRuntimePayload(
          existingRuntime?.runtimePayload ?? null,
          binding.runtimePayload,
        ),
      })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsert")));
  });

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (threadId) =>
    getBinding(threadId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () =>
            Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getProvider",
                detail: `No persisted provider binding found for thread '${threadId}'.`,
              }),
            ),
        }),
      ),
    );

  const remove: ProviderSessionDirectoryShape["remove"] = (threadId) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* getBinding(threadId));
        if (
          hasCodexRewindMarker(binding?.runtimePayload) ||
          hasPendingInspectionTerminal(binding?.runtimePayload)
        ) {
          // Session teardown must not erase the durable uncertainty fence.
          yield* upsert({ threadId, provider: binding!.provider, status: "stopped" }).pipe(
            Effect.mapError(toPersistenceError("ProviderSessionDirectory.remove:preserveRewind")),
          );
          return;
        }
        yield* repository
          .deleteByThreadId({ threadId })
          .pipe(
            Effect.mapError(toPersistenceError("ProviderSessionDirectory.remove:deleteByThreadId")),
          );
      }),
    );

  const setCodexRewind: NonNullable<ProviderSessionDirectoryShape["setCodexRewind"]> = (
    threadId,
    marker,
    operationId,
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const existing = Option.getOrUndefined(
          yield* repository
            .getByThreadId({ threadId })
            .pipe(
              Effect.mapError(toPersistenceError("ProviderSessionDirectory.setCodexRewind:read")),
            ),
        );
        const payload = isRecord(existing?.runtimePayload) ? existing.runtimePayload : {};
        const previous = payload[CODEX_REWIND_KEY];
        if (
          !existing ||
          (previous != null && (!isRecord(previous) || previous.operationId !== operationId)) ||
          (marker !== null && marker.operationId !== operationId)
        ) {
          return yield* new ProviderValidationError({
            operation: "ProviderSessionDirectory.setCodexRewind",
            issue: "Rewind binding or operation identity changed; the durable fence was retained.",
          });
        }
        if (!repository.setCodexRewind)
          return yield* new ProviderValidationError({
            operation: "ProviderSessionDirectory.setCodexRewind",
            issue: "Atomic rewind marker persistence is unavailable.",
          });
        const changed = yield* repository
          .setCodexRewind(threadId, marker, operationId)
          .pipe(
            Effect.mapError(toPersistenceError("ProviderSessionDirectory.setCodexRewind:write")),
          );
        if (!changed)
          return yield* new ProviderValidationError({
            operation: "ProviderSessionDirectory.setCodexRewind",
            issue: "Atomic rewind marker identity/stage check failed; fence retained.",
          });
      }),
    );

  const listThreadIds: ProviderSessionDirectoryShape["listThreadIds"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listThreadIds:list")),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listBindings: ProviderSessionDirectoryShape["listBindings"] = (input) =>
    repository.list(input).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listBindings:list")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeProviderKind(row.providerName, "ProviderSessionDirectory.listBindings").pipe(
            Effect.map((provider) => toRuntimeBinding(row, provider)),
          ),
        ),
      ),
    );

  return {
    ...makeDirectoryInspection(repository),
    ...makeDirectoryCompaction(repository),
    upsert: (binding) => writes.withPermits(1)(upsert(binding)),
    setCodexRewind,
    getProvider,
    getBinding,
    remove,
    listThreadIds,
    listBindings,
  } satisfies ProviderSessionDirectoryShape;
});

export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);

export function makeProviderSessionDirectoryLive() {
  return Layer.effect(ProviderSessionDirectory, makeProviderSessionDirectory);
}

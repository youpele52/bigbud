import type { CursorSettings } from "@bigbud/contracts/core/settings.ts";
import type { CursorModelOptions } from "@bigbud/contracts/core/model.ts";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "../Layers/Cursor/Provider.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type CursorAcpRuntimeCursorSettings = Pick<CursorSettings, "apiEndpoint" | "binaryPath">;

export interface CursorAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
  readonly mcpServers?: ReadonlyArray<import("effect-acp/schema").McpServer>;
  readonly spawnCwd?: string;
}

export interface CursorAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  const endpoint = cursorSettings?.apiEndpoint?.trim();
  return {
    command: cursorSettings?.binaryPath || "agent",
    args: [...(endpoint ? (["-e", endpoint] as const) : []), "--trust", "acp"],
    cwd,
  };
}

export const makeCursorAcpRuntime = (
  input: CursorAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCursorAcpSpawnInput(input.cursorSettings, input.spawnCwd ?? input.cwd),
        authMethodId: "cursor_login",
        clientCapabilities: {
          ...CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
          ...input.clientCapabilities,
        },
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

/**
 * One-shot Cursor ACP use: the agent lives only for `use`. However `use` ends (success, failure,
 * interruption, an outer timeout), its scope is closed, which kills the agent's process group with
 * the bounded release (`AcpChildProcessRelease`). The close runs in a detached fiber, so the
 * agent's teardown (up to a few seconds for a worker that ignores SIGTERM) neither delays the
 * result nor counts against the caller's timeout. Prefer this over `makeCursorAcpRuntime` unless
 * the runtime must outlive the caller (sessions).
 */
export const withCursorAcpRuntime = <A, E, R>(
  input: CursorAcpRuntimeInput,
  use: (runtime: AcpSessionRuntimeShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | EffectAcpErrors.AcpError, Exclude<R, Scope.Scope>> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const exit = yield* restore(
        makeCursorAcpRuntime(input).pipe(
          Effect.flatMap(use),
          Effect.provideService(Scope.Scope, scope),
        ),
      ).pipe(Effect.exit);
      yield* Effect.forkDetach(Scope.close(scope, exit));
      return yield* exit;
    }),
  );

interface CursorAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly modelOptions: CursorModelOptions | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    yield* input.runtime.setModel(resolveCursorAcpBaseModelId(input.model)).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-model",
        }),
      ),
    );

    const configUpdates = resolveCursorAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.modelOptions,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}

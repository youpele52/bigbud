import { type DevinModelOptions, type DevinSettings } from "@bigbud/contracts";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  resolveDevinAcpBaseModelId,
  resolveDevinAcpConfigUpdates,
} from "../Layers/Devin/Provider.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
}

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
    cwd,
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd),
        clientCapabilities: {},
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

interface DevinAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: DevinAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly modelOptions: DevinModelOptions | null | undefined;
  readonly mapError: (context: DevinAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelOption = configOptions.find((opt) => opt.category === "model");
    const resolvedModel = resolveDevinAcpBaseModelId(input.model);

    // Devin's ACP only exposes the currently selected model in config options.
    // If the requested model isn't available, skip model selection to avoid "invalid params" errors.
    if (modelOption && modelOption.type === "select") {
      const availableValues = modelOption.options.flatMap((entry) =>
        "value" in entry ? [entry.value.trim()] : entry.options.map((o) => o.value.trim()),
      );
      if (resolvedModel && !availableValues.includes(resolvedModel)) {
        yield* Effect.logWarning("Devin model not available in ACP config options, skipping", {
          requestedModel: resolvedModel,
          availableModels: availableValues,
        });
        // Skip model selection - use the default model from ACP
      } else {
        yield* input.runtime.setModel(resolvedModel).pipe(
          Effect.mapError((cause) =>
            input.mapError({
              cause,
              step: "set-model",
            }),
          ),
        );
      }
    } else {
      // No model config option available, skip model selection
      yield* Effect.logWarning("Devin ACP has no model config option, skipping model selection");
    }

    const configUpdates = resolveDevinAcpConfigUpdates(configOptions, input.modelOptions);
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

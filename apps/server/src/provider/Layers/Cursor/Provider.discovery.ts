import * as nodeOs from "node:os";

import type { CursorSettings, ModelCapabilities, ServerProviderModel } from "@bigbud/contracts";
import { Cause, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { AcpSessionRuntime } from "../../acp/AcpSessionRuntime.ts";
import { buildCursorAcpSpawnInput } from "../../acp/CursorAcpSupport.ts";
import {
  buildCursorCapabilitiesFromConfigOptions,
  buildCursorDiscoveredModels,
  buildCursorDiscoveredModelsFromConfigOptions,
  findCursorModelConfigOption,
  flattenSessionConfigSelectOptions,
  hasCursorModelCapabilities,
} from "./Provider.config.ts";
import {
  CURSOR_ACP_MODEL_CAPABILITY_TIMEOUT,
  CURSOR_ACP_MODEL_DISCOVERY_CONCURRENCY,
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  EMPTY_CAPABILITIES,
} from "./Provider.shared.ts";

const makeCursorAcpProbeRuntime = (cursorSettings: CursorSettings) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const probeCwd = nodeOs.homedir();
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: buildCursorAcpSpawnInput(cursorSettings, probeCwd),
        cwd: probeCwd,
        clientInfo: { name: "bigcode-provider-probe", version: "0.0.0" },
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

const withCursorAcpProbeRuntime = <A, E, R>(
  cursorSettings: CursorSettings,
  useRuntime: (acp: AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
) => makeCursorAcpProbeRuntime(cursorSettings).pipe(Effect.flatMap(useRuntime), Effect.scoped);

export const discoverCursorModelsViaAcp = (cursorSettings: CursorSettings) =>
  withCursorAcpProbeRuntime(cursorSettings, (acp) =>
    Effect.map(acp.start(), (started) =>
      buildCursorDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
    ),
  );

export const discoverCursorModelCapabilitiesViaAcp = (
  cursorSettings: CursorSettings,
  existingModels: ReadonlyArray<ServerProviderModel>,
) =>
  withCursorAcpProbeRuntime(cursorSettings, (acp) =>
    Effect.gen(function* () {
      const started = yield* acp.start();
      const initialConfigOptions = started.sessionSetupResult.configOptions ?? [];
      const modelOption = findCursorModelConfigOption(initialConfigOptions);
      const modelChoices = flattenSessionConfigSelectOptions(modelOption);
      if (!modelOption || modelChoices.length === 0) {
        return [];
      }

      const currentModelValue =
        modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
      const capabilitiesBySlug = new Map<string, ModelCapabilities>();
      if (currentModelValue) {
        capabilitiesBySlug.set(
          currentModelValue,
          buildCursorCapabilitiesFromConfigOptions(initialConfigOptions),
        );
      }

      const targetModelSlugs = new Set(
        existingModels
          .filter((model) => !model.isCustom && !hasCursorModelCapabilities(model))
          .map((model) => model.slug),
      );
      if (targetModelSlugs.size === 0) {
        return buildCursorDiscoveredModels(
          modelChoices.map((modelChoice) => ({
            slug: modelChoice.value.trim(),
            name: modelChoice.name.trim(),
            capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
          })),
        );
      }

      const probedCapabilities = yield* Effect.forEach(
        modelChoices,
        (modelChoice) => {
          const modelSlug = modelChoice.value.trim();
          if (!modelSlug || !targetModelSlugs.has(modelSlug) || capabilitiesBySlug.has(modelSlug)) {
            return Effect.void.pipe(
              Effect.as<readonly [string, ModelCapabilities] | undefined>(undefined),
            );
          }

          return withCursorAcpProbeRuntime(cursorSettings, (probeAcp) =>
            Effect.gen(function* () {
              const probeStarted = yield* probeAcp.start();
              const probeConfigOptions = probeStarted.sessionSetupResult.configOptions ?? [];
              const probeModelOption = findCursorModelConfigOption(probeConfigOptions);
              const probeCurrentModelValue =
                probeModelOption?.type === "select"
                  ? probeModelOption.currentValue?.trim() || undefined
                  : undefined;
              yield* Effect.annotateCurrentSpan({
                "cursor.acp.model.value": modelSlug,
                "cursor.acp.model.currentValue": probeCurrentModelValue,
                "cursor.acp.config_option_id": probeModelOption?.id ?? modelOption.id,
              });
              const nextConfigOptions =
                probeCurrentModelValue === modelSlug
                  ? probeConfigOptions
                  : yield* probeAcp
                      .setConfigOption(probeModelOption?.id ?? modelOption.id, modelSlug)
                      .pipe(Effect.map((response) => response.configOptions ?? probeConfigOptions));
              return [
                modelSlug,
                buildCursorCapabilitiesFromConfigOptions(nextConfigOptions),
              ] as const;
            }),
          ).pipe(
            Effect.timeout(CURSOR_ACP_MODEL_CAPABILITY_TIMEOUT),
            Effect.retry({ times: 3 }),
            Effect.withSpan("cursor-acp-model-capability-probe"),
            Effect.catchCause((cause) =>
              Effect.logWarning("Cursor ACP capability probe failed", {
                modelSlug,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        },
        { concurrency: CURSOR_ACP_MODEL_DISCOVERY_CONCURRENCY },
      );

      for (const entry of probedCapabilities) {
        if (!entry) {
          continue;
        }
        capabilitiesBySlug.set(entry[0], entry[1]);
      }

      return buildCursorDiscoveredModels(
        modelChoices.map((modelChoice) => ({
          slug: modelChoice.value.trim(),
          name: modelChoice.name.trim(),
          capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
        })),
      );
    }).pipe(Effect.withSpan("cursor-acp-model-capability-discovery", {})),
  );

import * as nodeOs from "node:os";

import type { DevinSettings, ModelCapabilities, ServerProviderModel } from "@bigbud/contracts";
import { Cause, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { AcpSessionRuntime } from "../../acp/AcpSessionRuntime.ts";
import { buildDevinAcpSpawnInput } from "../../acp/DevinAcpSupport.ts";
import {
  buildDevinCapabilitiesFromConfigOptions,
  buildDevinDiscoveredModels,
  buildDevinDiscoveredModelsFromConfigOptions,
  findDevinModelConfigOption,
  flattenSessionConfigSelectOptions,
  hasDevinModelCapabilities,
} from "./Provider.config.ts";
import {
  DEVIN_ACP_MODEL_CAPABILITY_TIMEOUT,
  DEVIN_ACP_MODEL_DISCOVERY_CONCURRENCY,
  EMPTY_CAPABILITIES,
} from "./Provider.shared.ts";

const makeDevinAcpProbeRuntime = (devinSettings: DevinSettings) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const probeCwd = nodeOs.homedir();
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: buildDevinAcpSpawnInput(devinSettings, probeCwd),
        cwd: probeCwd,
        clientInfo: { name: "bigcode-provider-probe", version: "0.0.0" },
        clientCapabilities: {},
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

const withDevinAcpProbeRuntime = <A, E, R>(
  devinSettings: DevinSettings,
  useRuntime: (acp: AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
) => makeDevinAcpProbeRuntime(devinSettings).pipe(Effect.flatMap(useRuntime), Effect.scoped);

export const discoverDevinModelsViaAcp = (devinSettings: DevinSettings) =>
  withDevinAcpProbeRuntime(devinSettings, (acp) =>
    Effect.map(acp.start(), (started) =>
      buildDevinDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
    ),
  );

export const discoverDevinModelCapabilitiesViaAcp = (
  devinSettings: DevinSettings,
  existingModels: ReadonlyArray<ServerProviderModel>,
) =>
  withDevinAcpProbeRuntime(devinSettings, (acp) =>
    Effect.gen(function* () {
      const started = yield* acp.start();
      const initialConfigOptions = started.sessionSetupResult.configOptions ?? [];
      const modelOption = findDevinModelConfigOption(initialConfigOptions);
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
          buildDevinCapabilitiesFromConfigOptions(initialConfigOptions),
        );
      }

      const targetModelSlugs = new Set(
        existingModels
          .filter((model) => !model.isCustom && !hasDevinModelCapabilities(model))
          .map((model) => model.slug),
      );
      if (targetModelSlugs.size === 0) {
        return buildDevinDiscoveredModels(
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

          return withDevinAcpProbeRuntime(devinSettings, (probeAcp) =>
            Effect.gen(function* () {
              const probeStarted = yield* probeAcp.start();
              const probeConfigOptions = probeStarted.sessionSetupResult.configOptions ?? [];
              const probeModelOption = findDevinModelConfigOption(probeConfigOptions);
              const probeCurrentModelValue =
                probeModelOption?.type === "select"
                  ? probeModelOption.currentValue?.trim() || undefined
                  : undefined;
              yield* Effect.annotateCurrentSpan({
                "devin.acp.model.value": modelSlug,
                "devin.acp.model.currentValue": probeCurrentModelValue,
                "devin.acp.config_option_id": probeModelOption?.id ?? modelOption.id,
              });
              const nextConfigOptions =
                probeCurrentModelValue === modelSlug
                  ? probeConfigOptions
                  : yield* probeAcp
                      .setConfigOption(probeModelOption?.id ?? modelOption.id, modelSlug)
                      .pipe(Effect.map((response) => response.configOptions ?? probeConfigOptions));
              return [
                modelSlug,
                buildDevinCapabilitiesFromConfigOptions(nextConfigOptions),
              ] as const;
            }),
          ).pipe(
            Effect.timeout(DEVIN_ACP_MODEL_CAPABILITY_TIMEOUT),
            Effect.retry({ times: 3 }),
            Effect.withSpan("devin-acp-model-capability-probe"),
            Effect.catchCause((cause) =>
              Effect.logWarning("Devin ACP capability probe failed", {
                modelSlug,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        },
        { concurrency: DEVIN_ACP_MODEL_DISCOVERY_CONCURRENCY },
      );

      for (const entry of probedCapabilities) {
        if (!entry) {
          continue;
        }
        capabilitiesBySlug.set(entry[0], entry[1]);
      }

      return buildDevinDiscoveredModels(
        modelChoices.map((modelChoice) => ({
          slug: modelChoice.value.trim(),
          name: modelChoice.name.trim(),
          capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
        })),
      );
    }).pipe(Effect.withSpan("devin-acp-model-capability-discovery", {})),
  );

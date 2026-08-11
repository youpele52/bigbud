import type {
  ModelCapabilities,
  ProviderKind,
  ServerProvider,
  ServerProviderModel,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";

import { providerModelsFromSettings } from "./providerSnapshot";
import { getSubProviderDisplayName } from "./subProviderDisplayNames";
import { MANAGED_SERVER_PROVIDER_PROBE_TIMEOUT } from "./managedServerProbe.ts";
import { runCoordinatedProviderProbe } from "./providerProbeCoordinator.ts";

interface ManagedCatalogModel {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly capabilities?: { readonly reasoning?: boolean };
}

interface ManagedCatalogProvider {
  readonly name: string;
  readonly models?: Readonly<Record<string, ManagedCatalogModel>>;
}

export function resolveManagedServerCatalog(input: {
  readonly provider: Extract<ProviderKind, "kilocode" | "opencode">;
  readonly providers: ReadonlyArray<ManagedCatalogProvider>;
  readonly customModels: ReadonlyArray<string>;
  readonly builtInModels: ReadonlyArray<ServerProviderModel>;
  readonly emptyCapabilities: ModelCapabilities;
}): { readonly configured: boolean; readonly models: ReadonlyArray<ServerProviderModel> } {
  const models: ServerProviderModel[] = [];
  for (const provider of input.providers) {
    if (!provider.models) continue;
    for (const model of Object.values(provider.models)) {
      const supportsReasoning = model.capabilities?.reasoning === true;
      const modelName = model.name.trim();
      models.push({
        slug: model.id,
        name: modelName.length > 0 ? modelName : model.id,
        isCustom: false,
        group: getSubProviderDisplayName(provider.name),
        subProviderID: model.providerID,
        capabilities: {
          ...input.emptyCapabilities,
          reasoningEffortLevels: supportsReasoning
            ? [
                { value: "high", label: "High", isDefault: true },
                { value: "medium", label: "Medium" },
                { value: "low", label: "Low" },
              ]
            : [],
        },
      });
    }
  }

  return {
    configured: models.length > 0,
    models:
      models.length > 0
        ? [
            ...models,
            ...providerModelsFromSettings(
              [],
              input.provider,
              input.customModels,
              input.emptyCapabilities,
            ),
          ]
        : input.builtInModels,
  };
}

export const enrichManagedServerCatalog = Effect.fn("enrichManagedServerCatalog")(function* <
  E,
  R,
>(input: {
  readonly provider: Extract<ProviderKind, "kilocode" | "opencode">;
  readonly baseSnapshot: ServerProvider;
  readonly catalogSnapshot: Effect.Effect<ServerProvider, E, R>;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}) {
  const publishUnavailable = (checkedAt: string) =>
    input.publishSnapshot({
      ...input.baseSnapshot,
      checkedAt,
      message: `${input.provider === "opencode" ? "OpenCode" : "KiloCode"} is ready. Its full model catalog is temporarily unavailable; bigbud will retry in the background.`,
      modelDiscovery: {
        status: "unavailable",
        source: `${input.provider}-provider-catalog`,
        durationMs: 0,
      },
    });
  const result = yield* runCoordinatedProviderProbe(
    input.catalogSnapshot,
    MANAGED_SERVER_PROVIDER_PROBE_TIMEOUT,
  );
  if (Option.isNone(result)) {
    yield* Effect.logWarning("provider model catalog refresh timed out", {
      provider: input.provider,
    });
    yield* publishUnavailable(new Date().toISOString());
    return;
  }

  const snapshot = result.value;
  if (snapshot.failure?.classification === "retryable") {
    yield* Effect.logWarning("provider model catalog refresh failed", {
      provider: input.provider,
      classification: snapshot.failure.classification,
      reason: snapshot.failure.reason,
    });
    yield* publishUnavailable(snapshot.checkedAt);
    return;
  }

  yield* input.publishSnapshot({
    ...snapshot,
    version: snapshot.version ?? input.baseSnapshot.version,
  });
});

/**
 * Live provisioning environment (WP-5C): settings, the provider registry's published readiness
 * snapshots, the provider service PATH and the existing Copilot runtime lifecycle.
 *
 * Status never starts a provider or vendor service: auth comes from the registry snapshot
 * (the recipes' referenced readiness checks), and executables are only resolved, not run.
 */
import { ProviderProvisioningError } from "@bigbud/contracts/server/providerProvisioning.ts";
import type { ProvisionableProviderKind } from "@bigbud/contracts/server/providerProvisioning.ts";
import * as Effect from "effect/Effect";

import { isMuslHost } from "../provider/Layers/Copilot/Runtime.discovery.ts";
import { copilotRuntimeRequest } from "../provider/Layers/Copilot/Runtime.service.ts";
import { resolveBundledPiCliPath } from "../provider/Layers/Pi/Cli.ts";
import type { ProviderRegistryShape } from "../provider/Services/ProviderRegistry.ts";
import type { ServerSettingsShape } from "../ws/serverSettings.ts";
import type { ProvisioningEnvironment } from "./provision.ts";
import type { PlatformTuple, RecipeArch, RecipeOs } from "./recipe.ts";
import { currentProviderServicePath } from "./servicePath.runtime.ts";

export function hostPlatformTuple(): PlatformTuple {
  const os = process.platform as RecipeOs;
  return {
    os,
    arch: process.arch as RecipeArch,
    libc: os !== "linux" ? "none" : isMuslHost() ? "musl" : "glibc",
  };
}

/** Reads `a.b.c` from plain settings objects; non-string leaves are ignored. */
export function readSettingsValue(settings: unknown, key: string): string | undefined {
  let value: unknown = settings;
  for (const part of key.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : undefined;
}

export interface LiveProvisioningServices {
  readonly mode: string;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings">;
  readonly providerRegistry: Pick<ProviderRegistryShape, "getProviders">;
}

/** Built per request so settings, snapshots and the Copilot runtime state are current. */
export const makeLiveProvisioningEnvironment = Effect.fn("makeLiveProvisioningEnvironment")(
  function* (services: LiveProvisioningServices) {
    const settings = yield* services.serverSettings.getSettings.pipe(
      Effect.mapError(
        () => new ProviderProvisioningError({ code: "failed", message: "Settings unavailable." }),
      ),
    );
    const snapshots = yield* services.providerRegistry.getProviders;
    const servicePath = yield* currentProviderServicePath(services.mode);
    const copilotSettings = settings.providers.copilot;
    const environment: ProvisioningEnvironment = {
      remote: services.mode === "remote",
      tuple: hostPlatformTuple(),
      discovery: servicePath.discovery,
      configuredValue: (key) => readSettingsValue(settings, key),
      snapshot: (kind: ProvisionableProviderKind) =>
        snapshots.find((snapshot) => snapshot.provider === kind),
      piClosurePath: resolveBundledPiCliPath,
      copilot: {
        status: () => copilotRuntimeRequest({ action: "status" }, copilotSettings),
        install: () => copilotRuntimeRequest({ action: "install" }, copilotSettings),
      },
    };
    return { environment, servicePath: servicePath.source };
  },
);

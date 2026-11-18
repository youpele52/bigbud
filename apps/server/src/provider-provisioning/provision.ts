/**
 * Provider provisioning action (P7 increment 5, WP-5C), one per recipe.
 *
 * Decision 6:
 * - Copilot: bigbud installs its pinned runtime through the existing `Runtime.install.ts` job
 *   (the caller holds setup authority in remote mode). An explicit binary path is never replaced.
 * - Pi: satisfied by the graph closure; availability is reported, nothing is installed.
 * - Everyone else: reports `needs-install` with the recipe's exact manual commands. bigbud never
 *   runs a vendor installer, pipes a script into a shell, or starts a vendor service (OpenCode
 *   v2 is borrow-only: status reads the registry snapshot and never ensures the service).
 */
import type { ServerProvider } from "@bigbud/contracts";
import type { CopilotRuntimeState } from "@bigbud/contracts/server/copilotRuntime.ts";
import {
  ProviderProvisioningError,
  type ProviderProvisioningEntry,
  type ProviderProvisionResult,
  type ProvisionableProviderKind,
} from "@bigbud/contracts/server/providerProvisioning.ts";
import * as Effect from "effect/Effect";

import { DEFAULT_PI_BINARY_PATH } from "../provider/Layers/Pi/Cli.ts";
import {
  buildProvisioningEntry,
  outcomeForState,
  type ExecutableSource,
  type InstallFinding,
} from "./provision.readiness.ts";
import { platformTupleKey, recipeSupportsTuple, validateRecipe } from "./recipe.ts";
import type { PlatformTuple, ProviderRecipe } from "./recipe.ts";
import { PROVIDER_RECIPES } from "./recipes/index.ts";
import { resolveProviderExecutable, type ServicePathDiscovery } from "./servicePath.ts";

export const DEFAULT_COPILOT_BINARY_PATH = "copilot";

export interface ProvisioningEnvironment {
  /** Remote backends check the graph tuples; desktop/web ship every component locally. */
  readonly remote: boolean;
  readonly tuple: PlatformTuple;
  readonly discovery: ServicePathDiscovery;
  /** Reads a dotted settings key such as `providers.codex.binaryPath`. */
  readonly configuredValue: (settingsKey: string) => string | undefined;
  /** Latest snapshot from the recipe's referenced readiness check, via the provider registry. */
  readonly snapshot: (kind: ProvisionableProviderKind) => ServerProvider | undefined;
  /** The graph's bundled Pi CLI entry, when the closure is present. */
  readonly piClosurePath: () => string | undefined;
  readonly copilot: {
    readonly status: () => Promise<CopilotRuntimeState>;
    /** Starts the existing pinned-runtime install job (Runtime.install.ts). */
    readonly install: () => Promise<CopilotRuntimeState>;
  };
}

const COPILOT_SOURCES: Record<CopilotRuntimeState["source"], ExecutableSource | undefined> = {
  configured: "explicit",
  managed: "managed",
  "bundled-native": "bundled",
  existing: "existing",
  sdk: "sdk",
  missing: undefined,
};

const copilotFinding = (state: CopilotRuntimeState): InstallFinding => {
  const source = COPILOT_SOURCES[state.source];
  return state.available && source
    ? { kind: "present", path: state.path, source }
    : {
        kind: "missing",
        message: state.diagnostic ?? state.error ?? "No Copilot runtime is installed.",
      };
};

const copilotCall = (operation: string, run: () => Promise<CopilotRuntimeState>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ProviderProvisioningError({
        code: "failed",
        message: `Copilot runtime ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const userExecutablesFinding = Effect.fn("userExecutablesFinding")(function* (
  recipe: ProviderRecipe,
  env: ProvisioningEnvironment,
) {
  let primary: InstallFinding | undefined;
  for (const component of recipe.components) {
    if (component.kind !== "vendorExecutable" || component.suppliedBy !== "user") continue;
    const settingsKey = component.discovery.settingsKey;
    const resolution = yield* resolveProviderExecutable({
      configuredPath: settingsKey ? env.configuredValue(settingsKey) : undefined,
      commandNames: component.discovery.commandNames,
      discovery: env.discovery,
    });
    if (resolution.source === "missing") {
      const names = resolution.searched.join(", ");
      return { kind: "missing", message: `${component.description}: ${names} not found.` } as const;
    }
    primary ??= { kind: "present", path: resolution.path, source: resolution.source };
  }
  return primary ?? ({ kind: "present", path: null, source: "bundled" } as const);
});

const installFinding = Effect.fn("installFinding")(function* (
  recipe: ProviderRecipe,
  env: ProvisioningEnvironment,
) {
  if (env.remote && !recipeSupportsTuple(recipe, env.tuple)) {
    return {
      kind: "unsupported",
      message: `bigbud has no ${recipe.displayName} artifact for ${platformTupleKey(env.tuple)}.`,
    } satisfies InstallFinding;
  }
  if (recipe.kind === "copilot") {
    return copilotFinding(yield* copilotCall("status", env.copilot.status));
  }
  if (recipe.kind === "pi") {
    const configured = env.configuredValue("providers.pi.binaryPath")?.trim();
    if (configured && configured !== DEFAULT_PI_BINARY_PATH) {
      const resolution = yield* resolveProviderExecutable({
        configuredPath: configured,
        commandNames: [],
        discovery: env.discovery,
      });
      return resolution.source === "missing"
        ? ({ kind: "missing", message: `Configured Pi CLI ${configured} not found.` } as const)
        : ({ kind: "present", path: resolution.path, source: resolution.source } as const);
    }
    const closure = env.piClosurePath();
    return closure
      ? ({ kind: "present", path: closure, source: "bundled" } as const)
      : ({ kind: "missing", message: "The Pi closure is not in this backend graph." } as const);
  }
  return yield* userExecutablesFinding(recipe, env);
});

export const providerProvisioningEntry = Effect.fn("providerProvisioningEntry")(function* (
  kind: ProvisionableProviderKind,
  env: ProvisioningEnvironment,
) {
  const recipe = PROVIDER_RECIPES[kind];
  const issues = validateRecipe(recipe);
  if (issues.length > 0) return yield* Effect.die(new Error(issues.join("; ")));
  return buildProvisioningEntry(recipe, yield* installFinding(recipe, env), env.snapshot(kind));
});

export const providerProvisioningStatus = Effect.fn("providerProvisioningStatus")(function* (
  env: ProvisioningEnvironment,
  only?: ProvisionableProviderKind,
) {
  const kinds = only ? [only] : (Object.keys(PROVIDER_RECIPES) as ProvisionableProviderKind[]);
  const entries: ProviderProvisioningEntry[] = [];
  for (const kind of kinds) entries.push(yield* providerProvisioningEntry(kind, env));
  return entries;
});

export const provisionProvider = Effect.fn("provisionProvider")(function* (
  kind: ProvisionableProviderKind,
  env: ProvisioningEnvironment,
) {
  const entry = yield* providerProvisioningEntry(kind, env);
  const configuredCopilot = env.configuredValue("providers.copilot.binaryPath")?.trim();
  const installsCopilot =
    kind === "copilot" &&
    entry.state === "missing" &&
    (!configuredCopilot || configuredCopilot === DEFAULT_COPILOT_BINARY_PATH);
  if (!installsCopilot) {
    return {
      outcome: outcomeForState(entry.state),
      entry,
      copilotJob: null,
    } satisfies ProviderProvisionResult;
  }
  const state = yield* copilotCall("install", env.copilot.install);
  if (state.error !== null || state.job === null || state.job.phase === "error") {
    const message = state.error ?? state.job?.error ?? "Copilot install did not start.";
    return yield* new ProviderProvisioningError({ code: "failed", message });
  }
  return { outcome: "installing", entry, copilotJob: state.job } satisfies ProviderProvisionResult;
});

import { Effect } from "effect";
import type { OptionalProviderRegistration } from "../../ProviderRegistration.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { readV2DevelopmentConfig } from "./Development.config.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { makeIsolatedOpencodeV2Adapter } from "./Adapter.execution.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { makeDormantOpencodeV2Adapter } from "./Adapter.ts";
import { makeDormantOpencodeV2Provider } from "./Provider.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { realpath } from "node:fs/promises";

/** Opt-in dev routing, not public preview. Invalid config cannot block other providers' startup. */
export const makeV2DevelopmentRegistration = Effect.fn("makeV2DevelopmentRegistration")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const capabilities = {
    supportsRemoteProviderRuntime: false,
    supportsLocalRuntimeRemoteWorkspace: false,
    toolInjectionMode: "mcp" as const,
    needsBuiltinsDisabled: true,
    compactionBehavior: "unknown" as const,
    tokenUsageSemantics: "cumulative-only" as const,
    sessionHistorySemantics: "persistent" as const,
  };
  const config = yield* Effect.tryPromise({
    try: () => readV2DevelopmentConfig(environment),
    catch: () => undefined,
  }).pipe(Effect.option);
  if (config._tag === "None") {
    const dormant = makeDormantOpencodeV2Provider();
    const snapshot = dormant.getSnapshot.pipe(
      Effect.map((value) => ({
        ...value,
        developmentOnly: true,
        message:
          "V2 development requires explicit BIGBUD_OPENCODE_V2_BINARY, PROFILE_ROOT, WORKSPACE and a disposable ownership marker. No discovery or fallback was attempted.",
      })),
    );
    return {
      provider: "opencodeV2",
      providerService: {
        ...dormant,
        getSnapshot: snapshot,
        refresh: snapshot,
        refreshWithRecovery: () => snapshot,
      },
      adapterService: makeDormantOpencodeV2Adapter(),
      capabilities: {
        ...capabilities,
        tokenUsageSemantics: "unavailable",
        sessionHistorySemantics: "unknown",
      },
    } satisfies OptionalProviderRegistration;
  }
  const journal = yield* ProviderTurnAdmissions;
  const manager = new OpencodeV2ServerManager({
    maxProcesses: 1,
    maxOwners: 32,
    maxQueuedEvents: 256,
    maxEventBytes: 2000000,
    consumerTimeoutMs: 10000,
  });
  const settings = yield* ServerSettingsService;
  const { adapter, runtime } = yield* makeIsolatedOpencodeV2Adapter({
    manager,
    journal,
    config: config.value.process,
    authorizeExecution: async () => {
      const allowed = await Effect.runPromise(
        settings.getSettings.pipe(
          Effect.map((value) => value.providers.opencodeV2.enabled),
          Effect.orElseSucceed(() => false),
        ),
      );
      if (!allowed) throw new Error("V2 development is disabled in settings.");
    },
  });
  const enabled = Effect.gen(function* () {
    const value = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterValidationError({
            provider: "opencodeV2",
            operation: "developmentAdmission",
            issue: "V2 development settings are unavailable.",
          }),
      ),
    );
    if (!value.providers.opencodeV2.enabled)
      return yield* new ProviderAdapterValidationError({
        provider: "opencodeV2",
        operation: "developmentAdmission",
        issue: "V2 development is disabled in settings.",
      });
  });
  const workspace = (directory: string | undefined) =>
    Effect.tryPromise({
      try: async () => {
        if (!directory || (await realpath(directory)) !== config.value.workspace)
          throw new Error("workspace");
      },
      catch: () =>
        new ProviderAdapterValidationError({
          provider: "opencodeV2",
          operation: "developmentWorkspace",
          issue:
            "V2 development requires the explicitly configured isolated workspace; remote and other directories are unavailable.",
        }),
    });
  const guarded = {
    ...adapter,
    startSession: (input: Parameters<typeof adapter.startSession>[0]) =>
      enabled.pipe(
        Effect.andThen(workspace(input.cwd)),
        Effect.andThen(adapter.startSession(input)),
      ),
    sendTurn: (input: Parameters<typeof adapter.sendTurn>[0]) =>
      enabled.pipe(Effect.andThen(adapter.sendTurn(input))),
    runBackgroundReview: (input: Parameters<NonNullable<typeof adapter.runBackgroundReview>>[0]) =>
      enabled.pipe(
        Effect.andThen(workspace(input.cwd)),
        Effect.andThen(adapter.runBackgroundReview!(input)),
      ),
  };
  const providerService = yield* makeV2DevelopmentProvider(runtime, config.value);
  return {
    provider: "opencodeV2",
    providerService,
    adapterService: guarded,
    capabilities,
  } satisfies OptionalProviderRegistration;
});

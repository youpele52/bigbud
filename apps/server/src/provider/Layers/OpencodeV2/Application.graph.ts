import path from "node:path";
import { Effect } from "effect";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import type { ServerConfigShape } from "../../../startup/config.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import type { OpencodeV2SharedBindingsShape } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { ThreadToolsActivation } from "../../Services/OpencodeV2/ThreadToolsActivation.ts";
import { hasOpencodeV2NativeTrust } from "@bigbud/shared/opencodeNativeTrust";
import { currentV2RequestContext } from "./Client.guard.ts";
import { v2ApplicationConfigKey } from "./Application.configKey.ts";
import { makeV2RequiredOrchestration } from "./Application.orchestration.lazy.ts";
import { makeV2NativeFamilyPreparation } from "./Subagents.application.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";
import { makeSharedOpencodeV2Adapter } from "./Adapter.shared.ts";
import { makeV2SharedTargetPreparation } from "./Application.targets.shared.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { detachV2BorrowedRuntime } from "./Runtime.transport.ts";
import type { readV2SharedApplicationConfig } from "./Application.shared.ts";
import type { V2BackendInstance } from "./Orchestration.instances.ts";
import { V2OwnerRecovery } from "./Application.recovery.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";

type Config = Awaited<ReturnType<typeof readV2SharedApplicationConfig>>;

/** Durable owner/broker graph; only descriptor, clients and hubs rotate across native upgrades. */
export const makeV2ApplicationGraph = Effect.fn("makeV2ApplicationGraph")(function* (
  config: Config,
  key: string,
  server: ServerConfigShape,
  bindings: OpencodeV2SharedBindingsShape,
  backend?: V2BackendInstance,
) {
  const settings = yield* ServerSettingsService;
  const journal = yield* ProviderTurnAdmissions;
  const activation = yield* ThreadToolsActivation;
  const consent = activation.consent;
  const orchestration = makeV2RequiredOrchestration(
    server.stateDir,
    activation,
    config.process.sharedService,
    backend,
  );
  const families = makeV2NativeFamilyPreparation(server.stateDir);
  yield* Effect.addFinalizer(() => Effect.promise(() => families.close()));
  yield* Effect.addFinalizer(() => Effect.promise(() => orchestration.close()));
  const manager = new OpencodeV2ServerManager({
    maxProcesses: 26,
    maxOwners: 32,
    maxQueuedEvents: 256,
    maxEventBytes: 2000000,
    consumerTimeoutMs: 10000,
    consent,
    start: (next) => {
      if (!next.sharedService)
        throw new Error("V2 production rejects private process acquisition.");
      return borrowV2SharedService(next.sharedService);
    },
  });
  const execution = {
    manager,
    journal,
    sharedBindings: bindings,
    consent,
    config: config.process,
    threadBridge: orchestration.bridge,
    threadToolsPreflight: orchestration.preflight,
    activation: orchestration.activation,
    profileIssuer: orchestration.issuer,
    allowLocalWorkspace: true,
    enableLocalTools: true,
    nativeSubagents: { stateDirectory: server.stateDir, prepare: families.prepare },
    attachmentsDir: server.attachmentsDir,
    attachmentAdmissionsDir: path.join(server.stateDir, "opencode-v2-attachment-admissions"),
    authorizeExecution: async () => {
      currentV2RequestContext()?.permit.assertCurrent();
      const current = (await Effect.runPromise(settings.getSettings)).providers.opencodeV2;
      currentV2RequestContext()?.permit.assertCurrent();
      if (
        !current.enabled ||
        v2ApplicationConfigKey(current) !== key ||
        !hasOpencodeV2NativeTrust(current)
      )
        throw new Error("V2 native configuration changed; execution remains blocked.");
    },
  };
  const executing = yield* makeSharedOpencodeV2Adapter({
    ...execution,
    prepareSession: (input, signal, disabled) =>
      makeV2SharedTargetPreparation(
        { ...execution, emit: async () => {} },
        server.stateDir,
        server.port,
      )(input, signal, disabled),
  });
  // The provider reads this stable object on each new lease acquisition.
  const current = { ...config };
  const provider = yield* makeV2DevelopmentProvider(executing.runtime, current, true);
  const recovering = new V2OwnerRecovery<V2RuntimeSession>();
  return {
    key,
    consentRevision: consent.currentRevision(),
    adapter: executing.adapter,
    provider,
    get connection() {
      return current.process.sharedService;
    },
    detach: () => detachV2BorrowedRuntime(executing.runtime),
    replace: async (next: Config, validate: () => void) => {
      await detachV2BorrowedRuntime(executing.runtime);
      validate();
      if (
        next.process.sharedService.storageIdentity !== current.process.sharedService.storageIdentity
      )
        throw new Error("V2 storage identity changed; retained history cannot be rebound.");
      current.process = next.process;
      execution.config = next.process;
      executing.runtime.options = { ...executing.runtime.options, config: next.process };
      orchestration.replaceDescriptor(next.process.sharedService);
    },
    recover: (signal: AbortSignal, validate: () => void) =>
      recovering.run(
        [...executing.runtime.sessions.values()],
        signal,
        validate,
        (owner) => Boolean(owner.transportDetached || owner.transportRecovering),
        (owner, abort) => executing.runtime.reconnect(owner, abort, validate),
        (owner, error) => {
          owner.executionBlocked =
            error instanceof Error && error.message.startsWith("V2 retained")
              ? error.message
              : "V2 generation readiness remains unconfirmed; no replacement or resend.";
          owner.session = { ...owner.session, status: "error", lastError: owner.executionBlocked };
        },
      ),
  };
});

export type V2ApplicationGraph = Effect.Success<ReturnType<typeof makeV2ApplicationGraph>>;

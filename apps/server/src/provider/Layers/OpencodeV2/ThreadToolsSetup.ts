import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { recoverV2RebootForSetup } from "./RebootRecovery.setup.ts";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { OpencodeV2SharedBindings } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderSessionRuntimeRepository } from "../../../persistence/Services/ProviderSessionRuntime.ts";
import { v2RetainedHistoryIssue } from "./ThreadToolsSetup.history.ts";
import type { V2ThreadToolsSetupShape } from "../../Services/OpencodeV2/ThreadToolsSetup.ts";
import type {
  ServerOpencodeV2ThreadToolsSetupInput,
  ServerOpencodeV2ThreadToolsSetupResult,
} from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { ThreadToolsActivation } from "../../Services/OpencodeV2/ThreadToolsActivation.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { readV2SharedApplicationConfig } from "./Application.shared.ts";
import { v2SharedRegistrationFile } from "./SharedService.registration.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";
import { V2ThreadImplementationRegistry } from "./Orchestration.implementation.ts";
import { V2ImplementationSelection } from "./Orchestration.implementation.selection.ts";
import { verifyV2ThreadTools } from "./Orchestration.readiness.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { resolveV2PluginConfigRoot } from "./PluginSetup.paths.ts";
import { hasOpencodeV2ManagedPluginTrust } from "@bigbud/shared/opencodeNativeTrust";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { inferredV2SetupLocation } from "./ThreadToolsSetup.location.ts";
import { resolveDefaultChatCwd } from "../../../ws/serverSettings.persistence.ts";
import { selectV2SetupArtifact } from "./ThreadToolsSetup.registration.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { v2ApplicationConfigKey } from "./Application.configKey.ts";
import { v2NativeCompatibilitySetupResult } from "./ThreadToolsSetup.compatibility.ts";
import { v2NativeProofMetadata, v2NativeReadyNotice } from "./NativeCompatibility.status.ts";

/** Setup may publish only the explicitly acknowledged managed entry; it cannot enroll, dispatch or reload. */
export const makeV2ThreadToolsSetup = Effect.fn("makeV2ThreadToolsSetup")(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const bindings = yield* Effect.serviceOption(OpencodeV2SharedBindings);
  const journal = yield* Effect.serviceOption(ProviderTurnAdmissions);
  const histories = yield* Effect.serviceOption(ProviderSessionRuntimeRepository);
  const engine = yield* Effect.serviceOption(OrchestrationEngineService);
  const activation = yield* ThreadToolsActivation;
  const recoverySql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const get = (input: ServerOpencodeV2ThreadToolsSetupInput) =>
    Effect.promise(async (callerSignal): Promise<ServerOpencodeV2ThreadToolsSetupResult> => {
      callerSignal.throwIfAborted();
      if (input.operation === "status" || input.operation === "cancel-interest") {
        try {
          const state = activation.lookup(
            input.jobId,
            input.operation === "cancel-interest" ? input.interestId : undefined,
          );
          const readyNotice = v2NativeReadyNotice(
            "Required bootstrap verified. A later normal foreground action may proceed; no prompt was resumed in the background.",
          );
          return {
            status: state.state === "ready" ? "ready" : "required",
            directory: state.directory,
            artifactDirectoryUri: "",
            artifactDigest: state.state === "ready" ? (state.installedBootstrapDigest ?? "") : "",
            issuerKeyId: "",
            configAddition: { plugins: [] },
            activationState: state.state,
            ...(state.reasonCode ? { reasonCode: state.reasonCode } : {}),
            ...(state.nativeVersion ? { nativeVersion: state.nativeVersion } : {}),
            ...(state.qualificationState ? { qualificationState: state.qualificationState } : {}),
            ...(state.nativeContractDigest
              ? { nativeContractDigest: state.nativeContractDigest }
              : {}),
            ...(state.qualificationRecordId
              ? { qualificationRecordId: state.qualificationRecordId }
              : {}),
            ...(state.semanticProfile ? { semanticProfile: state.semanticProfile } : {}),
            desiredBootstrapDigest: state.desiredDigest,
            ...(state.state === "ready"
              ? { installedBootstrapDigest: state.installedBootstrapDigest ?? "" }
              : {}),
            jobId: state.jobId,
            ...(state.retryAfter ? { retryAfter: state.retryAfter } : {}),
            severity:
              state.state === "ready"
                ? readyNotice.severity
                : ["failed", "uncertain"].includes(state.state) ||
                    state.qualificationState === "incompatible"
                  ? "error"
                  : "warning",
            message:
              state.state === "ready"
                ? readyNotice.message
                : (state.reason ??
                  "Automatic setup is waiting/checking known native activity; history is retained."),
          };
        } catch {
          return {
            status: "unavailable",
            directory: path.resolve(config.cwd ?? process.cwd()),
            artifactDirectoryUri: "",
            artifactDigest: "",
            issuerKeyId: "",
            configAddition: { plugins: [] },
            activationState: "blocked",
            severity: "warning",
            message:
              "Activation handle is absent or its scope changed; passive status did not create a new installer job.",
          };
        }
      }
      const original = settings.currentSnapshot?.()?.settings.providers.opencodeV2;
      const permit =
        input.refresh && original?.enabled && hasOpencodeV2ManagedPluginTrust(original)
          ? activation.consent.capture()
          : undefined;
      const unavailable: ServerOpencodeV2ThreadToolsSetupResult = {
        status: "unavailable",
        directory: input.directory ?? path.resolve(config.cwd ?? process.cwd()),
        artifactDirectoryUri: "",
        artifactDigest: "",
        issuerKeyId: "",
        configAddition: { plugins: [] },
        message:
          "Required thread-tools setup did not verify. Existing history and unrelated native configuration are preserved; no service administration or prompt fallback was performed.",
        severity: "error",
      };
      try {
        const full = await Effect.runPromise(settings.getSettings);
        permit?.assertCurrent();
        const value = full.providers.opencodeV2;
        const inferred = await inferredV2SetupLocation(
          input,
          resolveDefaultChatCwd(full),
          Option.getOrUndefined(engine),
        );
        if (!path.isAbsolute(inferred)) return unavailable;
        const directory = await realpath(inferred);
        let artifact = await exportV2ThreadArtifact(config.stateDir);
        const implementations = new V2ThreadImplementationRegistry();
        await V2ImplementationSelection.open(artifact, implementations);
        const defaultImplementationDigest = implementations.current().implementationDigest;
        permit?.assertCurrent();
        const result = {
          ...unavailable,
          directory,
          artifactDirectoryUri: artifact.pluginUri,
          artifactDigest: artifact.artifactDigest,
          issuerKeyId: artifact.issuer,
          configAddition: { plugins: [artifact.pluginUri] },
          nativePluginConfigRoot: resolveV2PluginConfigRoot(value.nativePluginConfigRoot),
          severity: "warning" as const,
        };
        if (input.threadId) {
          if (Option.isNone(histories) || Option.isNone(bindings) || Option.isNone(journal))
            return {
              ...result,
              status: "unavailable",
              message:
                "Retained history classification is unavailable; no native history was accessed or changed.",
            };
          const binding = Option.isSome(bindings)
            ? await Effect.runPromise(bindings.value.find(input.threadId))
            : undefined;
          const admission = Option.isSome(journal)
            ? await Effect.runPromise(journal.value.latestBound(input.threadId))
            : undefined;
          const history = Option.isSome(histories)
            ? await Effect.runPromise(histories.value.getByThreadId({ threadId: input.threadId }))
            : Option.none();
          const issue = v2RetainedHistoryIssue({
            binding,
            hasAdmission: Boolean(admission),
            directory,
            ...(Option.isSome(history) && history.value.providerName === "opencodeV2"
              ? { cursor: history.value.resumeCursor }
              : {}),
          });
          if (issue) return { ...result, status: "incompatible-history", message: issue };
          artifact = await selectV2SetupArtifact(artifact, {
            threadId: input.threadId,
            directory,
            binding,
            admission,
            ...(Option.isSome(history) && history.value.providerName === "opencodeV2"
              ? { cursor: history.value.resumeCursor }
              : {}),
          });
          Object.assign(result, {
            artifactDirectoryUri: artifact.pluginUri,
            artifactDigest: artifact.artifactDigest,
            configAddition: { plugins: [artifact.pluginUri] },
          });
        }
        if (resolveOpencodeV2ConnectionMode(value) !== "shared")
          return {
            ...result,
            status: "incompatible-history",
            message:
              "Isolated V2 configuration is retired. Select shared service for new chats; retained history stays read-only without migration.",
          };
        if (!input.refresh)
          return {
            ...result,
            status: "required",
            message:
              "Chat/worktree Locations are detected automatically. After expanded native trust, bigbud manages only its required global plugin entry; execution verifies the actual Location before each new turn. Opening settings does not install anything.",
          };
        if (!permit || !value.enabled || !hasOpencodeV2ManagedPluginTrust(value))
          return {
            ...result,
            status: "required",
            message:
              "Enable OpenCode v2 and acknowledge native execution plus managed required-plugin installation. Previous host-user acknowledgement did not authorize configuration writes.",
          };
        return await runV2RequestContext(
          {
            permit,
            transport: value.serviceFile?.trim() || v2SharedRegistrationFile(),
            intent: "execute",
          },
          async () => {
            permit.assertCurrent();
            const current = settings.currentSnapshot?.()?.settings.providers.opencodeV2;
            if (
              !current ||
              v2ApplicationConfigKey(current) !== v2ApplicationConfigKey(value) ||
              current.nativePluginConfigRoot !== value.nativePluginConfigRoot ||
              !hasOpencodeV2ManagedPluginTrust(current)
            )
              throw new Error(
                "V2 automatic setup settings changed before native acquisition; no stale installation.",
              );
            const shared = await readV2SharedApplicationConfig(value, directory);
            if (input.threadId) {
              const binding = Option.isSome(bindings)
                ? await Effect.runPromise(bindings.value.find(input.threadId))
                : undefined;
              const retained = Option.isSome(journal)
                ? await Effect.runPromise(journal.value.latestBound(input.threadId))
                : undefined;
              if (
                retained &&
                (!binding ||
                  binding.storageIdentity !== shared.process.sharedService.storageIdentity ||
                  binding.directory !== directory)
              )
                return {
                  ...result,
                  status: "incompatible-history",
                  message:
                    "Retained native ownership is unsupported here; canonical history remains read-only without replacement or replay.",
                };
            }
            const connection = await borrowV2SharedService(shared.process.sharedService);
            let installedBootstrapDigest = artifact.artifactDigest;
            let nativeProof:
              | Awaited<ReturnType<typeof verifyV2ThreadTools>>["nativeProof"]
              | undefined;
            try {
              if (v2ThreadRegistration(artifact).family === "legacy") {
                const { nativeProof } = await verifyV2ThreadTools(
                  artifact,
                  connection.client,
                  directory,
                  callerSignal,
                  undefined,
                  activation.nativeEligibility,
                  result.nativePluginConfigRoot,
                );
                return {
                  ...result,
                  status: "ready",
                  activationState: "ready",
                  ...v2NativeProofMetadata(nativeProof),
                  ...v2NativeReadyNotice(
                    "Exact retained legacy bootstrap verified. Its global entry and native history are unchanged; new chats use the independent profile-scoped registration.",
                  ),
                } as ServerOpencodeV2ThreadToolsSetupResult;
              }
              await recoverV2RebootForSetup({
                artifact,
                activation,
                descriptor: shared.process.sharedService,
                client: connection.client,
                sql: Option.getOrUndefined(recoverySql),
                signal: callerSignal,
              });
              const requested = activation.requestSetup(
                artifact,
                shared.process.sharedService,
                directory,
                callerSignal,
              );
              const state = await activation.jobs.wait(
                requested.handle,
                requested.scope,
                callerSignal,
              );
              if (state.state !== "ready")
                return {
                  ...result,
                  status: "required",
                  artifactDigest: "",
                  activationState: state.state,
                  ...(state.reasonCode ? { reasonCode: state.reasonCode } : {}),
                  ...(state.nativeVersion ? { nativeVersion: state.nativeVersion } : {}),
                  ...(state.qualificationState
                    ? { qualificationState: state.qualificationState }
                    : {}),
                  desiredBootstrapDigest: artifact.artifactDigest,
                  defaultImplementationDigest,
                  jobId: requested.handle.jobId,
                  interestId: requested.handle.interestId,
                  ...(state.retryAfter ? { retryAfter: state.retryAfter } : {}),
                  severity:
                    ["failed", "uncertain"].includes(state.state) ||
                    state.qualificationState === "incompatible"
                      ? "error"
                      : "warning",
                  message:
                    state.reason ??
                    "Automatic setup is waiting for known native work. It never cancels that work; background success does not create a session or submit a prompt.",
                };
              installedBootstrapDigest = state.installedBootstrapDigest ?? artifact.artifactDigest;
              nativeProof = (
                await verifyV2ThreadTools(
                  await readV2RetainedArtifact(artifact, installedBootstrapDigest),
                  connection.client,
                  directory,
                  callerSignal,
                  undefined,
                  activation.nativeEligibility,
                  result.nativePluginConfigRoot,
                )
              ).nativeProof;
            } catch (error) {
              return {
                ...result,
                status: "unavailable",
                severity: "error",
                ...v2NativeCompatibilitySetupResult(error),
                message:
                  error instanceof Error && error.message.startsWith("V2 ")
                    ? error.message
                    : "V2 automatic required-plugin setup did not verify. Existing history and unrelated native configuration are preserved; retry without native service administration.",
              };
            } finally {
              await connection.close();
            }
            permit.assertCurrent();
            const activeImplementationDigest = input.threadId
              ? activation.activeImplementation(
                  artifact,
                  shared.process.sharedService,
                  directory,
                  input.threadId,
                )
              : undefined;
            return {
              ...result,
              status: "ready",
              activationState: "ready",
              artifactDigest: installedBootstrapDigest,
              installedBootstrapDigest,
              desiredBootstrapDigest: artifact.artifactDigest,
              defaultImplementationDigest,
              ...(activeImplementationDigest ? { activeImplementationDigest } : {}),
              ...(nativeProof
                ? {
                    ...v2NativeProofMetadata(nativeProof),
                  }
                : {}),
              ...v2NativeReadyNotice(
                "Required plugin ABI, issuer, artifact and detected Location verified. Compatible foreground chats enroll automatically. Only the proven required global entry is managed; account/model/permission settings are never changed.",
              ),
            };
          },
        );
      } catch (error) {
        return {
          ...unavailable,
          ...v2NativeCompatibilitySetupResult(error),
          message:
            error instanceof Error && error.message.startsWith("V2 ")
              ? error.message
              : unavailable.message,
        };
      } finally {
        permit?.release();
      }
    });
  return { get } satisfies V2ThreadToolsSetupShape;
});

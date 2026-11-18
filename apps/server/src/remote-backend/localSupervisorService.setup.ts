import { serviceSetupCompletion } from "./localSupervisorService.setup.completion.ts";
import { bindSetupControlOwner } from "./localSupervisorService.setup.control.ts";
import { makeLocalSupervisorAuthorityOwners } from "./localSupervisorOwners.ts";
import { assertLocalSupervisorAuthorityReservation } from "./localSupervisorAuthority.ts";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { LocalSupervisorPreflightContext } from "./localSupervisorService.preflight.ts";
import { withVerifiedBackendGraphReceipt } from "./backendGraph.receipt.ts";
import { revalidateBackendGraph } from "./backendGraph.ts";
import { readLocalSupervisorServiceFile } from "./localSupervisorService.files.ts";
import { encodeLocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";
import {
  createServiceNamespace,
  publishServiceFile,
} from "./localSupervisorService.setup.files.ts";
import { validateServiceSetup } from "./localSupervisorService.setup.validation.ts";
import {
  confirmSetupAgentState,
  inspectSetupAgentState,
  preserveAdoptedConnections,
  setupCandidateBuildIds,
} from "./localSupervisorService.setup.adoption.ts";
import {
  findSetupAdoptionRefusal,
  formatSetupRefusalLine,
} from "./localSupervisorService.setup.adoption.rules.ts";
import {
  localSupervisorServiceSetupDependencies,
  type LocalSupervisorServiceSetupDependencies,
} from "./localSupervisorService.setup.runtime.ts";
import {
  LocalSupervisorServiceSetupError,
  type LocalSupervisorServiceSetupInput,
  type LocalSupervisorServiceSetupResult,
  type LocalSupervisorServiceSetupPhase,
} from "./localSupervisorService.setup.types.ts";
import { quoteRemoteAgentLaunchValue as quote } from "../remote-agent/remoteAgentRuntime.launch.prepare.ts";

/** Trusted composition/test dependency seam only; never constructed from renderer or JSON input. */
export function makeLocalSupervisorServiceSetup(
  dependencies: LocalSupervisorServiceSetupDependencies = localSupervisorServiceSetupDependencies,
) {
  return async (
    context: LocalSupervisorPreflightContext,
    input: LocalSupervisorServiceSetupInput,
    external: AbortSignal,
  ): Promise<LocalSupervisorServiceSetupResult> => {
    const controller = new AbortController(),
      signal = controller.signal;
    const abort = () => controller.abort(external.reason);
    external.addEventListener("abort", abort, { once: true });
    if (external.aborted) abort();
    let phase: LocalSupervisorServiceSetupPhase = "validate",
      needsRepair = false;
    const checkpoint = async () => {
      signal.throwIfAborted();
      await context.owner.assertHeld();
      signal.throwIfAborted();
    };
    try {
      const selected = Object.freeze({ ...input, rustSource: structuredClone(input.rustSource) });
      const validated = await validateServiceSetup(
        context,
        selected,
        dependencies.account(),
        signal,
      );
      const control = bindSetupControlOwner(
        dependencies.control(validated.home, validated.target, signal),
        checkpoint,
        signal,
      );
      // Original proof immediately precedes the first account-state side effect.
      await revalidateBackendGraph(selected.graph, signal);
      await checkpoint();
      phase = "claim";
      // Read-only gate: fresh, or fully verified managed P4 state to adopt, or a typed refusal.
      const agentState = await inspectSetupAgentState({
        control,
        identity: context.identity,
        backendStateDir: context.owner.stateDir,
        candidateBuildIds: setupCandidateBuildIds(validated.rustSource, validated.graph.target),
        signal,
      });
      await checkpoint();
      needsRepair = true;
      await dependencies.claim(control, context.identity, {
        confirmFreshSetup: true,
        backendHome: validated.backendHome,
        backendStateDir: context.owner.stateDir,
        ...(agentState.mode === "adopt" ? { adoptExistingState: true as const } : {}),
      });
      // Nothing else may have changed between the verified snapshot and the ownership claim.
      await confirmSetupAgentState(control, agentState);
      await checkpoint();
      phase = "publish-config";
      // Durable namespace presence fences all later partial staging/publication retries.
      await createServiceNamespace(validated.configRoot, checkpoint);
      await checkpoint();
      phase = "stage-runtime";
      const runtime = await dependencies.install(control, validated.rustSource, signal, agentState);
      await checkpoint();
      phase = "publish-config";
      const boot = (
        await control.run(validated.target, "cat /proc/sys/kernel/random/boot_id", {
          timeoutMs: 8000,
          maxBufferBytes: 256,
          signal,
        })
      ).stdout.trim();
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot))
        throw new Error("Service setup requires an exact current Linux boot identity.");
      const reservation = await readLocalSupervisorServiceFile(
        join(control.root, "account-authority-v1"),
        32 * 1024,
      );
      const reservationSha = createHash("sha256").update(reservation).digest("hex");
      await withVerifiedBackendGraphReceipt(
        selected.graph,
        async (receipt) => {
          await checkpoint();
          await publishServiceFile(
            join(validated.configRoot, "artifact-receipt"),
            receipt.raw,
            checkpoint,
          );
          await publishServiceFile(
            join(validated.configRoot, "client-token"),
            randomBytes(32).toString("hex"),
            checkpoint,
          );
          await publishServiceFile(
            validated.configPath,
            encodeLocalSupervisorServiceConfig({
              version: "1",
              authority: context.identity.authority.authorityId,
              home: validated.home,
              backend_home: validated.backendHome,
              rust_binary: runtime.binaryPath,
              rust_sha256: runtime.sha256,
              rust_state: runtime.statePath,
              node_binary: receipt.nodePath,
              node_sha256: receipt.nodeSha256,
              backend_entry: receipt.entryPath,
              backend_sha256: receipt.entrySha256,
              receipt_sha256: receipt.sha256,
              restart: selected.restart ? "yes" : "no",
              launch_attempt: `setup-${selected.requestId}`,
              prior_epoch: "fresh",
              launch_boot: boot,
              expected_installation_fingerprint: context.identity.installationFingerprint,
              authority_reservation_sha256: reservationSha,
            }),
            checkpoint,
          );
        },
        signal,
      );
      await checkpoint();
      await revalidateBackendGraph(selected.graph, signal);
      phase = "stage-units";
      await control.run(
        validated.target,
        `${quote(runtime.binaryPath)} --backend-service stage ${quote(validated.configPath)} --confirm-startup`,
        { timeoutMs: 60000, maxBufferBytes: 64 * 1024, signal },
      );
      await checkpoint();
      phase = "admit-runtime";
      const scopedContext = {
        ...context,
        owners: preserveAdoptedConnections(
          makeLocalSupervisorAuthorityOwners({
            owners: context.owners,
            targetId: validated.target,
            assertAuthority: async () => {
              await checkpoint();
              await assertLocalSupervisorAuthorityReservation(control, context.identity);
            },
          }),
          agentState,
        ),
      };
      const epoch = await dependencies.admit(
        scopedContext,
        control,
        runtime,
        validated.configPath,
        selected.requestId,
        signal,
      );
      await checkpoint();
      await revalidateBackendGraph(selected.graph, signal);
      phase = "publish-completion";
      await publishServiceFile(
        join(validated.configRoot, "setup-complete-v1"),
        await serviceSetupCompletion(context, selected.requestId, runtime, epoch),
        checkpoint,
      );
      await checkpoint();
      return Object.freeze({
        status: "configured",
        requestId: selected.requestId,
        authorityId: context.identity.authority.authorityId,
        installationFingerprint: context.identity.installationFingerprint,
        configPath: validated.configPath,
        runtime,
        epoch,
        backendEnabled: false,
        backendStarted: false,
      });
    } catch (cause) {
      const refusal = findSetupAdoptionRefusal(cause);
      if (refusal) dependencies.reportRefusal?.(formatSetupRefusalLine(refusal));
      throw new LocalSupervisorServiceSetupError({
        phase,
        needsRepair,
        message: needsRepair
          ? "Account setup did not settle; preserve its state and inspect it before retrying."
          : "Account setup was refused before mutation.",
        cause,
      });
    } finally {
      controller.abort();
      external.removeEventListener("abort", abort);
    }
  };
}
export const setupLocalSupervisorService = makeLocalSupervisorServiceSetup();

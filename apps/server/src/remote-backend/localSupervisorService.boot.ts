import type { RemoteBackendIdentity } from "./authority.ts";
import { assertLocalSupervisorAuthorityReservation } from "./localSupervisorAuthority.ts";
import { scopeLocalSupervisorControl } from "./localSupervisorControl.scope.ts";
import { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { remoteAgentBuildId, remoteAgentRuntimeEqual } from "../remote-agent/remoteAgentRuntime.ts";
import { restartRemoteAgentRuntime } from "../remote-agent/remoteAgentRestart.runtime.ts";
import { makeLocalSupervisorInstaller } from "./localSupervisorInstaller.ts";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import {
  connectLocalSupervisorProxy,
  makeLocalSupervisorTransportFactory,
} from "./localSupervisorTransport.ts";
import { makeLocalSupervisorServiceLauncher } from "./localSupervisorService.launch.ts";
import { makeLocalSupervisorBootProgressStore } from "./localSupervisorService.boot.store.ts";

/** Finite boot reconciliation. Lock/identity/SQL ownership belongs to the caller's scoped entry. */
export function makeLocalSupervisorBootReconciler(input: {
  readonly control: LocalSupervisorControl;
  readonly owners: RemoteAgentOwnerStore;
  readonly configPath: string;
  readonly identity: Pick<RemoteBackendIdentity, "authority" | "installationFingerprint">;
}) {
  const { control: baseControl, owners } = input;
  const target = baseControl.targetId;
  if (target !== `remote-backend:${input.identity.authority.authorityId}`)
    throw new Error("Boot control must belong to the loaded backend authority.");
  let retainedPool: RemoteAgentConnectionPool | undefined;
  let active = false;
  let closed = false;
  const assertTarget = async (selected: string) => {
    if (selected !== target)
      throw new Error("Boot reconciliation cannot address another authority or SSH target.");
  };
  return {
    close: () => {
      closed = true;
      retainedPool?.closeAll();
    },
    reconcile: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (closed || active)
        throw new Error("The finite boot reconciler is closed or already active.");
      active = true;
      try {
        await assertLocalSupervisorAuthorityReservation(baseControl, input.identity);
        signal.throwIfAborted();
        const control = scopeLocalSupervisorControl(baseControl, signal);
        const installer = makeLocalSupervisorInstaller({ control });
        const admission = installer.createAdmission(owners, async (selected, runtime) => {
          await assertTarget(selected);
          return connectLocalSupervisorProxy(runtime);
        });
        const pool = new RemoteAgentConnectionPool(
          makeLocalSupervisorTransportFactory({
            targetId: target,
            resolveBinding: () => admission.resolveBinding(target),
          }),
        );
        const launcher = makeLocalSupervisorServiceLauncher({
          control,
          configPath: input.configPath,
          signal,
        });

        retainedPool?.closeAll();
        retainedPool = pool;
        const owner = await control.openControl(target);
        const state = await owner.registry.read();
        const selected = state.builds.find((entry) => entry.id === state.current);
        if (
          !selected?.authenticated ||
          selected.binary !== "present" ||
          selected.health !== "healthy" ||
          selected.runtime.origin !== "managed"
        )
          throw new Error(
            "Boot requires an existing signed admitted managed runtime; run explicit setup first.",
          );
        const binding = await admission.resolveBinding(target);
        if (
          !binding ||
          !remoteAgentRuntimeEqual(binding.runtime, selected.runtime) ||
          remoteAgentBuildId(binding.runtime) !== state.current
        )
          throw new Error("Boot runtime selection conflicts with canonical durable admission.");
        const bootId = (
          await control.run(target, "cat /proc/sys/kernel/random/boot_id", {
            timeoutMs: 8000,
            maxBufferBytes: 256,
          })
        ).stdout.trim();
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(bootId))
          throw new Error("Account service boot requires a verified Linux boot identity.");
        const requestId = `account-boot:${target}:${bootId}:${binding.runtime.generation}`;
        signal.throwIfAborted();
        const prior = state.restartReservations.find((entry) => entry.id === requestId);
        if (
          state.retirementReservations.some((entry) => entry.buildId === selected.id) ||
          state.restartReservations.some(
            (entry) =>
              entry.generation === selected.runtime.generation &&
              entry.id !== requestId &&
              !["failed", "ready"].includes(entry.phase),
          )
        )
          throw new Error("Another canonical runtime operation owns boot reconciliation.");
        if (!prior || prior.phase === "ready" || prior.phase === "failed") {
          try {
            await admission.verify(target, binding.runtime, binding.expectedEpoch);
            signal.throwIfAborted();
            await pool.getBound(target, binding, [
              "terminal.pty",
              "terminal.pty-inventory",
              "terminal.shell-profiles",
              "workspace.files",
            ]);
            signal.throwIfAborted();
            return {
              status: "adopted" as const,
              runtime: binding.runtime,
              epoch: binding.expectedEpoch,
            };
          } catch (error) {
            signal.throwIfAborted();
            if (prior?.phase === "ready" || prior?.phase === "failed") throw error;
            // A failed proxy is not death evidence; the canonical core must independently prove death.
          }
        }
        const oldEpoch = prior?.expectedEpoch ?? binding.expectedEpoch;
        const progress = makeLocalSupervisorBootProgressStore({
          control,
          runtime: binding.runtime,
          oldEpoch,
          requestId,
        });
        const result = await restartRemoteAgentRuntime(
          {
            store: progress,
            stopLiveSupervisor: false,
            verifySsh: async (selected) => {
              signal.throwIfAborted();
              await assertTarget(selected);
            },
            resolveBinding: admission.resolveBinding,
            control: async (selected) => {
              await assertTarget(selected);
              return owner;
            },
            launchReplacement: launcher.launchReplacement,
            close: (selected, retired) => {
              if (retired) pool.closeBound(selected, retired);
            },
            reconnect: async (selected, replacement, retired) => {
              if (!replacement || !retired)
                throw new Error("Boot requires explicit replacement identities.");
              signal.throwIfAborted();
              await pool.admitReplacement(selected, replacement, retired);
              signal.throwIfAborted();
            },
            bindReplacement: async (selected, connectionId, replacement) => {
              signal.throwIfAborted();
              await owners.bindConnection(selected, connectionId, replacement);
              signal.throwIfAborted();
            },
            verifyReadiness: async (selected, runtime) => {
              signal.throwIfAborted();
              const epoch = await admission.verify(selected, runtime);
              signal.throwIfAborted();
              return epoch;
            },
            beginRetirement: (selected, generation) => pool.beginRetirement(selected, generation),
            reconcileRuntime: async (selected, retired) => {
              pool.reconcileRuntimeResources(selected, retired);
              await owners.reconcileRuntime?.(
                selected,
                retired.runtime.generation,
                retired.expectedEpoch,
              );
            },
          },
          { requestId, expectedWorkspaceExecutionTargetId: target },
          binding,
        );
        signal.throwIfAborted();
        if (result.phase !== "ready" || !result.replacementEpoch)
          throw new Error(
            "Account service boot replacement remains uncertain; preserve state and repair explicitly.",
          );
        return {
          status: "replaced" as const,
          runtime: binding.runtime,
          epoch: result.replacementEpoch,
        };
      } finally {
        active = false;
      }
    },
  };
}

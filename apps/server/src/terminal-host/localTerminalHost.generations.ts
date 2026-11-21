/**
 * Controls over every attached local host generation (plan §7.3 item 4, §14). The admitted
 * generation takes new terminals, but a draining generation still runs managed PTYs: quit
 * close-all, policy and inventory must reach it too. Nothing here launches or kills a host;
 * "Close them" signals only a start-time-verified PID through the controller.
 *
 * @module localTerminalHost.generations
 */
import type {
  RemoteAgentConnectionPool,
  RemoteAgentRuntimeBinding,
} from "../remote-agent/remoteAgentConnectionPool.ts";
import { REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY } from "../remote-agent/remoteAgentProtocol.ptyLifecycle.ts";
import { RemoteAgentPtyInventory } from "../remote-agent/remoteAgentPtyInventory.ts";
import { makeRemoteAgentHostControls } from "../remote-agent/remoteAgentPtyClient.lifecycle.ts";
import { requestRemoteAgentScreenSnapshot } from "../remote-agent/remoteAgentPtyClient.screen.ts";
import type {
  OwnedPtyHostGenerations,
  OwnedPtyHostInventoryEntry,
} from "../terminal/Services/OwnedPtyRuntime.ts";
import type { LocalTerminalHostController } from "./localTerminalHost.host.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

type Pool = Pick<RemoteAgentConnectionPool, "getBound">;

const connectionIdOf = (binding: RemoteAgentRuntimeBinding) =>
  binding.connectionId ?? binding.runtime.generation;

export function makeLocalTerminalHostGenerations(input: {
  readonly controller: LocalTerminalHostController;
  readonly pool: Pool;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}): OwnedPtyHostGenerations {
  const { controller, pool } = input;
  const connect = (binding: RemoteAgentRuntimeBinding) =>
    pool.getBound(LOCAL_TERMINAL_HOST_TARGET_ID, binding, ["terminal.pty"]);
  const controls = (binding: RemoteAgentRuntimeBinding) =>
    makeRemoteAgentHostControls(() => connect(binding));
  const lifecycleBindings = async () => {
    const bindings = await controller.attachedBindings();
    const capable: RemoteAgentRuntimeBinding[] = [];
    for (const entry of bindings) {
      const connection = await connect(entry.binding).catch(() => undefined);
      if (connection?.supportsCapability?.(REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY))
        capable.push(entry.binding);
    }
    return capable;
  };

  const inventory: OwnedPtyHostGenerations["inventory"] = async (signal) => {
    const reader = new RemoteAgentPtyInventory(pool);
    const entries: OwnedPtyHostInventoryEntry[] = [];
    for (const { binding } of await controller.attachedBindings()) {
      const listed = await reader
        .list(LOCAL_TERMINAL_HOST_TARGET_ID, binding, signal)
        .catch((cause: unknown) => {
          input.log?.("A terminal host generation's inventory is unavailable.", {
            connectionId: connectionIdOf(binding),
            cause: String(cause),
          });
          return [];
        });
      for (const entry of listed)
        entries.push({
          ptyId: entry.ptyId,
          connectionId: connectionIdOf(binding),
          state: entry.state,
          lost: entry.lost === true,
          ...(entry.activityState ? { activityState: entry.activityState } : {}),
          ...(entry.lastUsedMs ? { lastUsedMs: entry.lastUsedMs } : {}),
          lifecycleManaged: entry.lifecycleManaged === true,
        });
    }
    return entries;
  };

  return {
    ready: async () => {
      await controller.ready().catch(() => undefined);
    },
    admittedKey: async () => {
      const binding = await controller.currentAdmittedBinding();
      return binding ? `${connectionIdOf(binding)}:${binding.expectedEpoch}` : undefined;
    },
    inventory,
    updatePolicy: async (policy, signal) => {
      const results = await Promise.allSettled(
        (await lifecycleBindings()).map((binding) =>
          controls(binding).updatePolicy(policy, signal),
        ),
      );
      for (const result of results)
        if (result.status === "rejected")
          input.log?.("A terminal host generation refused the lifecycle policy.", {
            cause: String(result.reason),
          });
    },
    closeAll: async (request, signal) => {
      const bindings = await controller.attachedBindings();
      const results = await Promise.allSettled(
        bindings.map((entry) => controls(entry.binding).closeAll(request, signal)),
      );
      let closed = 0;
      let unreachable = 0;
      for (const result of results)
        if (result.status === "fulfilled") closed += result.value;
        else unreachable += 1;
      return { closed, unreachable };
    },
    coldSnapshot: async (ptyId, request) => {
      const owner = (await inventory(request.signal)).find((entry) => entry.ptyId === ptyId);
      const bindings = await controller.attachedBindings();
      const binding = bindings.find(
        (entry) => owner && connectionIdOf(entry.binding) === owner.connectionId,
      )?.binding;
      if (!binding) throw new Error("No terminal host still knows this terminal.");
      return requestRemoteAgentScreenSnapshot(await connect(binding), ptyId, request);
    },
    drainingNotices: () => controller.notices(),
    closeDrainingHosts: async () => {
      let closed = 0;
      let remaining = 0;
      for (const notice of controller.notices()) {
        if (!notice.canClose) {
          remaining += 1;
          continue;
        }
        try {
          await controller.closeDrainingHost(notice.generation);
        } catch (cause) {
          input.log?.("An old terminal host was left running.", {
            generation: notice.generation,
            cause: String(cause),
          });
        }
        if (controller.notices().some((entry) => entry.generation === notice.generation))
          remaining += 1;
        else closed += 1;
      }
      return { closed, remaining };
    },
  };
}

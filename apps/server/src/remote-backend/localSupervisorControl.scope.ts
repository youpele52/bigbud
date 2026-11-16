import { makeRemoteAgentRegistryStore } from "../remote-agent/remoteAgentInstall.registry.store.ts";
import {
  buildRemoteAgentInventoryCommand,
  parseRemoteAgentInventory,
} from "../remote-agent/remoteAgentUpdate.inventory.ts";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";

/** Same canonical P4 root/CAS, with every command owned by the finite operation's abort scope. */
export function scopeLocalSupervisorControl(
  control: LocalSupervisorControl,
  signal: AbortSignal,
): LocalSupervisorControl {
  const run: LocalSupervisorControl["run"] = (target, script, options) => {
    signal.throwIfAborted();
    return control.run(target, script, { ...options, signal });
  };
  return {
    ...control,
    run,
    openControl: async (target) => {
      signal.throwIfAborted();
      const opened = await control.openControl(target);
      signal.throwIfAborted();
      const command = { run: async (script: string) => (await run(target, script)).stdout };
      return {
        ...opened,
        run: command.run,
        registry: makeRemoteAgentRegistryStore(opened.root, command),
        inventory: async () =>
          parseRemoteAgentInventory(
            await command.run(buildRemoteAgentInventoryCommand(opened.root)),
          ),
      };
    },
  };
}

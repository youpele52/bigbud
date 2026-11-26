import { runRemoteAgentDiagnosedCommand } from "./remoteAgentDiagnostics.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import type { RemoteAgentCommandRunner } from "./remoteAgentCommand.types.ts";
import type { RemoteAgentControlOp } from "./remoteAgentControl.ops.ts";
import { REMOTE_AGENT_CONTROL_ROOT_SCRIPT } from "./remoteAgentControl.scripts.ts";
import { assertRemoteAgentControlRoot } from "./remoteAgentControl.root.ts";
import { openOwnerRemoteAgentControl } from "./remoteAgentControl.owner.install.ts";
import { remoteAgentOwnerSelection } from "./remoteAgentControl.selection.ts";
import {
  buildRemoteAgentInventoryCommand,
  parseRemoteAgentInventory,
  type RemoteAgentInventory,
} from "./remoteAgentUpdate.inventory.ts";

export interface RemoteAgentControl {
  readonly root: string;
  /** Runs one control script; `timeoutMs` (default 30 s) bounds the SSH command. */
  run: (command: string, options?: { readonly timeoutMs?: number }) => Promise<string>;
  readonly registry: ReturnType<typeof makeRemoteAgentRegistryStore>;
  readonly inventory?: () => Promise<RemoteAgentInventory>;
  /**
   * Production (U25): run one typed operation through the SSH owner. When set, every module
   * routes through it and `run` is never given script text.
   */
  readonly exec?: (op: RemoteAgentControlOp) => Promise<string>;
}

/** Resolve the verified account's canonical control root without opening any agent state. */
export async function openRemoteAgentControl(
  executionTargetId: string,
  runner?: RemoteAgentCommandRunner,
): Promise<RemoteAgentControl> {
  // U25: every control operation runs through the live SSH owner. `runner` is the
  // injected command seam (tests and the local supervisor), never a TypeScript SSH launch.
  if (!runner) return openOwnerRemoteAgentControl(remoteAgentOwnerSelection(), executionTargetId);
  const execute = runner;
  const run = async (command: string, options?: { readonly timeoutMs?: number }) => {
    const result = await runRemoteAgentDiagnosedCommand(execute, "control", {
      executionTargetId,
      command: "sh",
      args: ["-lc", command],
      timeoutMs: options?.timeoutMs ?? 30_000,
      maxBufferBytes: 2 * 1024 * 1024,
      outputMode: "error",
    });
    if (!result || typeof result !== "object" || !("stdout" in result))
      throw new Error("Missing remote control response.");
    return String(result.stdout);
  };
  const root = (await run(REMOTE_AGENT_CONTROL_ROOT_SCRIPT)).trim();
  assertRemoteAgentControlRoot(root);
  return {
    root,
    run,
    registry: makeRemoteAgentRegistryStore(root, { run }),
    inventory: async () =>
      parseRemoteAgentInventory(await run(buildRemoteAgentInventoryCommand(root))),
  } satisfies RemoteAgentControl;
}

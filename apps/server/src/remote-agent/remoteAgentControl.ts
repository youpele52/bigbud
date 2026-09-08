import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { hasRemoteAgentPathControls } from "./remoteAgentRuntime.ts";
import { runSshCommand, type RunSshCommandInput } from "../ssh/sshProcess.ts";
import {
  buildRemoteAgentInventoryCommand,
  parseRemoteAgentInventory,
  type RemoteAgentInventory,
} from "./remoteAgentUpdate.inventory.ts";

export interface RemoteAgentControl {
  readonly root: string;
  run: (command: string) => Promise<string>;
  readonly registry: ReturnType<typeof makeRemoteAgentRegistryStore>;
  readonly inventory?: () => Promise<RemoteAgentInventory>;
}

/** Resolve the verified account's canonical control root without opening any agent state. */
export async function openRemoteAgentControl(
  executionTargetId: string,
  execute: (input: RunSshCommandInput) => Promise<unknown> = runSshCommand,
): Promise<RemoteAgentControl> {
  const run = async (command: string) => {
    const result = await execute({
      executionTargetId,
      command: "sh",
      args: ["-lc", command],
      timeoutMs: 30_000,
      maxBufferBytes: 2 * 1024 * 1024,
      outputMode: "error",
    });
    if (!result || typeof result !== "object" || !("stdout" in result))
      throw new Error("Missing remote control response.");
    return String(result.stdout);
  };
  const root = (
    await run(`set -eu
umask 077
home=$(readlink -f -- "$HOME")
for path in "$home/.bigbud" "$home/.bigbud/agent"; do
  test ! -L "$path"
  if test ! -e "$path"; then mkdir -m 700 -- "$path" || test -d "$path"; fi
  test -d "$path"
  test "$(stat -c '%u' -- "$path")" = "$(id -u)"
  test "$(stat -c '%a' -- "$path")" = 700
done
printf '%s' "$home/.bigbud/agent"
`)
  ).trim();
  if (
    !root.startsWith("/") ||
    !root.endsWith("/.bigbud/agent") ||
    hasRemoteAgentPathControls(root)
  ) {
    throw new Error("Invalid remote control root.");
  }
  return {
    root,
    run,
    registry: makeRemoteAgentRegistryStore(root, { run }),
    inventory: async () =>
      parseRemoteAgentInventory(await run(buildRemoteAgentInventoryCommand(root))),
  } satisfies RemoteAgentControl;
}

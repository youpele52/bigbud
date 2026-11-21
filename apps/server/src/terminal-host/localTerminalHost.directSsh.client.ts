/**
 * Liveness and close for one Direct SSH host PTY (plan M7), without attaching to it. The local
 * host is the supervisor of its PTYs, so a reachable generation answers for them: a PTY it lists
 * as running is live, one it reports exited, closed or lost (or no longer lists, in the same
 * epoch) is gone. An unreachable generation, another epoch, or an unreaped child is `unknown`.
 *
 * @module localTerminalHost.directSsh.client
 */
import type {
  RemoteAgentConnectionPool,
  RemoteAgentRuntimeBinding,
} from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentControl } from "../remote-agent/remoteAgentControl.ts";
import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { closeRemotePty } from "../remote-agent/remoteAgentPtyClient.request.ts";
import { RemoteAgentPtyInventory } from "../remote-agent/remoteAgentPtyInventory.ts";
import type {
  OwnedPtyHostedStatus,
  OwnedPtyLocalSshClient,
} from "../terminal/Services/OwnedPtyRuntime.ts";
import type { LocalTerminalHostController } from "./localTerminalHost.host.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

/** The host's close answers after the reap or the escalation (a few seconds); then confirm. */
export const DIRECT_SSH_CLOSE_TIMEOUT_MS = 15_000;

const connectionIdOf = (binding: RemoteAgentRuntimeBinding) =>
  binding.connectionId ?? binding.runtime.generation;

type PtyEntries = Awaited<ReturnType<RemoteAgentPtyInventory["list"]>>;

export interface LocalTerminalHostSshClientDeps {
  readonly controller: Pick<LocalTerminalHostController, "attachedBindings">;
  readonly pool: Pick<RemoteAgentConnectionPool, "getBound">;
  readonly owners: () => RemoteAgentOwnerStore;
  readonly control: () => Promise<Pick<RemoteAgentControl, "registry">>;
  /** One generation's PTY inventory; rejects when it cannot be reached. */
  readonly listPtys?: (
    binding: RemoteAgentRuntimeBinding,
    signal?: AbortSignal,
  ) => Promise<PtyEntries>;
  /** `PtyClose { terminate: true }`; answers after the reap or the escalation. */
  readonly closePty?: (
    binding: RemoteAgentRuntimeBinding,
    ptyId: string,
    signal: AbortSignal,
  ) => Promise<void>;
}

export function makeLocalTerminalHostSshClient(
  deps: LocalTerminalHostSshClientDeps,
): OwnedPtyLocalSshClient {
  const listPtys =
    deps.listPtys ??
    ((binding: RemoteAgentRuntimeBinding, signal?: AbortSignal) =>
      new RemoteAgentPtyInventory(deps.pool).list(LOCAL_TERMINAL_HOST_TARGET_ID, binding, signal));
  const closePty =
    deps.closePty ??
    (async (binding: RemoteAgentRuntimeBinding, ptyId: string, signal: AbortSignal) => {
      const connection = await deps.pool.getBound(LOCAL_TERMINAL_HOST_TARGET_ID, binding, [
        "terminal.pty",
      ]);
      await closeRemotePty(connection, ptyId, true, signal);
    });
  const bindingOf = async (owner: RemoteAgentOwner) => {
    if (owner.target !== LOCAL_TERMINAL_HOST_TARGET_ID) return undefined;
    const attached = await deps.controller.attachedBindings().catch(() => []);
    return attached.find((entry) => connectionIdOf(entry.binding) === owner.connectionId)?.binding;
  };

  const status = async (
    owner: RemoteAgentOwner,
    signal?: AbortSignal,
  ): Promise<OwnedPtyHostedStatus> => {
    const binding = await bindingOf(owner);
    if (!binding) return "unknown";
    let entries: PtyEntries;
    try {
      entries = await listPtys(binding, signal);
    } catch {
      return "unknown";
    }
    const entry = entries.find((candidate) => candidate.ptyId === owner.resourceId);
    // A host that crashed lost the PTY with its master: the client got its hangup.
    if (entry?.lost) return "gone";
    if (binding.expectedEpoch !== owner.epoch) return "unknown";
    if (!entry) return "gone";
    if (entry.state === "running") return "live";
    if (entry.verifiedExit || entry.state === "exited" || entry.state === "closed") return "gone";
    return "unknown";
  };

  /** The owner row and build pin are released only after the host confirmed the exit. */
  const release = async (owner: RemoteAgentOwner) => {
    await deps
      .owners()
      .update(owner.ownerKey, (current) =>
        current.resourceId === owner.resourceId && current.state !== "terminal"
          ? { ...current, state: "terminal" }
          : current,
      );
    const pinOwner = `${owner.ownerKey}:${owner.resourceId}`;
    const control = await deps.control();
    await control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      pins: state.pins.filter((pin) => pin.owner !== pinOwner),
    }));
  };

  const close = async (owner: RemoteAgentOwner, signal?: AbortSignal) => {
    const binding = await bindingOf(owner);
    if (!binding || binding.expectedEpoch !== owner.epoch)
      throw new Error("The terminal host that runs this SSH session is unreachable.");
    const bounded = AbortSignal.any([
      AbortSignal.timeout(DIRECT_SSH_CLOSE_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    let closeError: unknown;
    try {
      await closePty(binding, owner.resourceId, bounded);
    } catch (cause) {
      // A PTY that already ended refuses the close; the inventory below decides.
      closeError = cause;
    }
    if ((await status(owner, signal)) !== "gone")
      throw new Error("The terminal host could not confirm that the SSH session ended.", {
        cause: closeError,
      });
    await release(owner);
  };

  return { status, close };
}

import * as Effect from "effect/Effect";

import { isRemoteAgentExecutionTarget } from "../remote-agent/remoteAgentDefault.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { nativeDirectSshBinding } from "../terminal-host/localTerminalHost.directSsh.owner.lifecycle.ts";
import type {
  NativeDirectSshTerminalBinding,
  NativeDirectSshTerminalOwner,
} from "../terminal-host/localTerminalHost.directSsh.owner.port.ts";
import {
  makeNativeDirectSshQuitCloser,
  registerNativeDirectSshQuitCloser,
} from "../terminal-host/localTerminalHost.directSsh.owner.quit.ts";
import { makeNativeDirectSshTerminal } from "../terminal-host/localTerminalHost.directSsh.owner.ts";
import { ownedTerminalOwnerRouteKey } from "../terminal/Layers/OwnedPtyRuntime.owner.ts";
import type { DirectSshTerminalCwdOwner } from "../terminal/Layers/Manager.cwd.owner.ts";
import {
  NativeSshPtyHostLostError,
  PtySpawnError,
  type PtyAdapterShape,
  type PtySpawnInput,
} from "../terminal/Services/PTY.ts";
import { parseSshExecutionTarget } from "./sshExecutionTarget.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.client.ts";
import type { PickerProofBoundTarget } from "./sshOwnerPickerProof.client.session.types.ts";
import {
  makePickerProofTerminalAdapter,
  type PickerProofTerminalAdapterClient,
} from "./sshOwnerPickerProof.terminalAdapter.ts";
import type { SshOwnerProductionRegistration } from "./sshOwnerProductionRegistry.ts";
import { descriptorServesTarget } from "./sshOwnerProductionTargets.ts";

/**
 * W2 T-term production direct-SSH terminals over the live owner.
 *
 * Each pane gets its own adapter bound to its exact target, keyed by the
 * owner's lease, and retired once the owner confirms that lease exited; a
 * retained lease from an earlier backend is recovered attach-only. The quit
 * closer snapshots the live target set at quit time and closes only exact
 * leases. Remote-agent targets never reach this owner (U6: they keep their
 * own keep-running policy). No legacy SSH fallback exists.
 *
 * @module sshOwnerProductionTerminal
 */

type ProductionRead = () => SshOwnerProductionRegistration | undefined;
type TerminalClient = PickerProofTerminalAdapterClient &
  Pick<PickerProofBoundTarget, "probeProofTerminalCwd" | "inspectTerminal" | "listTerminalShells">;

export interface SshOwnerProductionTerminalOptions {
  readonly read: ProductionRead;
  readonly owners: () => RemoteAgentOwnerStore;
  /** Production native-owner metadata stored with every durable lease row. */
  readonly runtime: RemoteAgentRuntime;
  /** Every bigbud target id (the project projection); read at quit time. */
  readonly targets: () => Promise<ReadonlyArray<string>>;
  /** U16: the owner-listed `/etc/shells` path for a selected profile. */
  readonly shellFor?: (input: PtySpawnInput) => string | undefined;
}

/** A direct (non-agent) SSH execution target. */
export const isProductionDirectSshTarget = (id: string | undefined): id is string =>
  parseSshExecutionTarget(id) !== null && !isRemoteAgentExecutionTarget(id);

/** Runs `use` with the live owner's client for this exact runtime target. */
export async function withProductionTerminalOwner<A>(
  read: ProductionRead,
  targetId: string,
  use: (owner: TerminalClient) => Promise<A>,
): Promise<A> {
  const live = read();
  // A missing or dead owner is host loss: the durable lease is kept, never replaced.
  if (!live) throw new NativeSshPtyHostLostError();
  const descriptor = await live.descriptorFor(targetId);
  if (!descriptorServesTarget(descriptor, targetId))
    throw new PickerProofOwnerError("targetMismatch");
  const bound = live.handle.target(descriptor);
  const client = Object.assign(Object.create(bound) as PickerProofBoundTarget, {
    ownerEpoch: Uint8Array.from(live.handle.ownerEpoch),
  });
  try {
    return await use(client);
  } catch (cause) {
    if (cause instanceof PickerProofOwnerError && cause.code === "ownerUnavailable")
      throw new NativeSshPtyHostLostError();
    throw cause;
  }
}

const leaseKey = (binding: NativeDirectSshTerminalBinding) =>
  `${binding.targetId}\0${binding.leaseId}`;

/** One adapter per lease; prepare creates it, a confirmed exit retires it. */
export function makeProductionTerminalPort(read: ProductionRead): NativeDirectSshTerminalOwner & {
  readonly liveLeases: () => number;
} {
  const adapters = new Map<string, NativeDirectSshTerminalOwner>();
  const fresh = (targetId: string, recover: boolean) =>
    makePickerProofTerminalAdapter(
      { withOwner: (use) => withProductionTerminalOwner(read, targetId, use) },
      targetId,
      recover,
    ).port;
  const lookup = (binding: NativeDirectSshTerminalBinding, recover: boolean) => {
    const existing = adapters.get(leaseKey(binding));
    if (existing) return existing;
    // A lease from an earlier backend is adopted attach-only; the owner proves it.
    if (!recover) throw new Error("No prepared native SSH terminal matches this lease.");
    const adopted = fresh(binding.targetId, true);
    adapters.set(leaseKey(binding), adopted);
    return adopted;
  };
  const settle = <S extends { readonly state: string }>(
    binding: NativeDirectSshTerminalBinding,
    status: S,
  ) => {
    if (status.state === "exited") adapters.delete(leaseKey(binding));
    return status;
  };
  return {
    async prepareOpen(input, signal) {
      const port = fresh(input.targetId, false);
      const binding = await port.prepareOpen(input, signal);
      adapters.set(leaseKey(binding), port);
      return binding;
    },
    open: async (input, binding, signal) => lookup(binding, false).open(input, binding, signal),
    reattach: async (binding, signal) => lookup(binding, true).reattach(binding, signal),
    status: async (binding, signal) =>
      settle(binding, await lookup(binding, true).status(binding, signal)),
    close: async (binding, signal) =>
      settle(binding, await lookup(binding, true).close(binding, signal)),
    liveLeases: () => adapters.size,
  };
}

export function makeSshOwnerProductionTerminal(options: SshOwnerProductionTerminalOptions) {
  const { read, owners, runtime } = options;
  const port = makeProductionTerminalPort(read);
  const native = makeNativeDirectSshTerminal(
    { port, owners, runtime, ...(options.shellFor ? { shellFor: options.shellFor } : {}) },
    isProductionDirectSshTarget,
    () => false,
  );
  const inspectFor = (targetId: string) => async (threadId: string, terminalId: string) => {
    const route = await owners().get(ownedTerminalOwnerRouteKey(threadId, terminalId));
    if (!route || route.target !== targetId || route.state === "terminal")
      throw new Error("No live native SSH lease for this pane.");
    const lease = Buffer.from(nativeDirectSshBinding(route).leaseId, "hex");
    const snapshot = await withProductionTerminalOwner(read, targetId, (owner) =>
      owner.inspectTerminal(lease),
    );
    return { shellPid: snapshot.shellPid, processes: snapshot.processes };
  };
  const { lifecycle } = native;
  const quitCloser = makeNativeDirectSshQuitCloser({
    targets: async () => (await options.targets()).filter(isProductionDirectSshTarget),
    owners,
    lifecycle,
  });
  const refuse = (message: string) =>
    Effect.fail(new PtySpawnError({ adapter: "native-ssh-owner", message }));

  function wrapPtyAdapter(original: PtyAdapterShape): PtyAdapterShape {
    const wrapped: PtyAdapterShape = {
      ...original,
      ownedRuntimeForTarget: (id) => {
        if (!isProductionDirectSshTarget(id)) return original.ownedRuntimeForTarget?.(id);
        const selected = native.runtimeForTarget(id);
        return selected && { ...selected, nativeSshProduction: { inspect: inspectFor(id) } };
      },
      spawn: (input) => {
        if (!isProductionDirectSshTarget(input.executionTargetId)) return original.spawn(input);
        if (!read()) return refuse("sshOwnerUnavailable: The SSH owner is not running.");
        // The manager's legacy executable, argv and env are not native launch operands.
        return native.spawn(input);
      },
    };
    registerNativeDirectSshQuitCloser(wrapped, quitCloser);
    return wrapped;
  }

  const cwdOwner: DirectSshTerminalCwdOwner = {
    async probeCwd(input, signal) {
      signal.throwIfAborted();
      // The owner probe resolves the exact absolute directory; `~` stays refused.
      if (input.home || !input.cwd.startsWith("/"))
        throw new Error("A native SSH terminal needs an absolute remote directory.");
      const cwd = await withProductionTerminalOwner(read, input.executionTargetId, (owner) =>
        owner.probeProofTerminalCwd(input.cwd),
      );
      signal.throwIfAborted();
      return { kind: "resolved", cwd };
    },
  };

  return { wrapPtyAdapter, cwdOwner, quitCloser, port };
}

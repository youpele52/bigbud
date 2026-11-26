import * as Effect from "effect/Effect";

import { makeNativeDirectSshTerminal } from "../terminal-host/localTerminalHost.directSsh.owner.ts";
import {
  makeNativeDirectSshQuitCloser,
  registerNativeDirectSshQuitCloser,
} from "../terminal-host/localTerminalHost.directSsh.owner.quit.ts";
import type { NativeDirectSshTerminalOptions } from "../terminal-host/localTerminalHost.directSsh.owner.ts";
import type { DirectSshTerminalCwdOwner } from "../terminal/Layers/Manager.cwd.owner.ts";
import {
  NativeSshPtyHostLostError,
  PtySpawnError,
  type PtyAdapterShape,
} from "../terminal/Services/PTY.ts";
import { SshOwnerDevPickerError } from "./sshOwnerDevPicker.errors.ts";
import { PickerProofOwnerError, type PickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  makePickerProofTerminalAdapter,
  type PickerProofTerminalAdapterClient,
} from "./sshOwnerPickerProof.terminalAdapter.ts";

type DevTerminalClient = PickerProofTerminalAdapterClient &
  Pick<PickerProofOwner, "probeProofTerminalCwd">;

interface SshOwnerDevTerminalOptions extends Pick<
  NativeDirectSshTerminalOptions,
  "owners" | "runtime"
> {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly recoverRetained?: boolean;
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: DevTerminalClient) => Promise<A>,
  ) => Promise<A>;
}

const fixtureOnly = "The Rust SSH terminal requires the exact development fixture target and root.";
const unsupported =
  "This SSH terminal launch policy is unavailable in Rust SSH owner development mode.";
const isSsh = (id: string | undefined) => id?.trimStart().startsWith("ssh:") ?? false;

/** Install once around the normal PTY service in the opted-in development graph. */
export function makeSshOwnerDevTerminal({
  targetId,
  workspaceRoot,
  recoverRetained = false,
  withOwner,
  owners,
  runtime,
}: SshOwnerDevTerminalOptions) {
  const isFixtureTarget = (id: string) => isSsh(id) && id === targetId;
  const inFixture = (id: string | undefined, cwd: string | undefined) =>
    id !== undefined && isFixtureTarget(id) && cwd === workspaceRoot;
  const { port } = makePickerProofTerminalAdapter(
    {
      withOwner: async (use) => {
        try {
          return await withOwner(targetId, use);
        } catch (cause) {
          if (
            (cause instanceof PickerProofOwnerError || cause instanceof SshOwnerDevPickerError) &&
            cause.code === "ownerUnavailable"
          )
            throw new NativeSshPtyHostLostError();
          throw cause;
        }
      },
    },
    targetId,
    recoverRetained,
  );
  const native = makeNativeDirectSshTerminal(
    { port, owners, runtime },
    isFixtureTarget,
    () => false,
  );
  const lifecycle = native.runtimeForTarget(targetId)?.localSshClient;
  if (!lifecycle) throw new Error(fixtureOnly);
  // Default quit closes only the exact leases it snapshots; keep mode never reaches it.
  const quitCloser = makeNativeDirectSshQuitCloser({ targets: [targetId], owners, lifecycle });
  let attached: { key: string; lease: string } | undefined;
  const refuse = (message: string) =>
    Effect.fail(new PtySpawnError({ adapter: "native-ssh-owner", message }));

  function wrapPtyAdapter(original: PtyAdapterShape): PtyAdapterShape {
    const wrapped: PtyAdapterShape = {
      ownedRuntimeForTarget: (id) => {
        if (!isSsh(id)) return original.ownedRuntimeForTarget?.(id);
        const selected = native.runtimeForTarget(id);
        return selected && { ...selected, nativeSshWorkspaceRoot: workspaceRoot };
      },
      spawn: (input) => {
        if (!isSsh(input.executionTargetId)) return original.spawn(input);
        if (!inFixture(input.executionTargetId, input.remoteCwd)) return refuse(fixtureOnly);
        if (input.shellLaunch || input.shellProfile || input.hostLifecycle?.evictPtyId)
          return refuse(unsupported);
        // The manager's legacy executable, argv and env are not native launch operands.
        return native.spawn(input).pipe(
          Effect.tap((process) =>
            Effect.sync(() => {
              if (input.ownerKey && process.remoteResourceId) {
                attached = { key: `terminal:${input.ownerKey}`, lease: process.remoteResourceId };
              }
            }),
          ),
        );
      },
    };
    registerNativeDirectSshQuitCloser(wrapped, quitCloser);
    return wrapped;
  }

  const preflight = async (id: string, cwd: string, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    if (!inFixture(id, cwd)) throw new Error(fixtureOnly);
    const resolved = await withOwner(targetId, (owner) => {
      signal.throwIfAborted();
      return owner.probeProofTerminalCwd(cwd);
    });
    signal.throwIfAborted();
    if (resolved !== workspaceRoot) throw new Error(fixtureOnly);
    return resolved;
  };
  const cwdOwner: DirectSshTerminalCwdOwner = {
    async probeCwd(input, signal) {
      if (input.home) throw new Error(fixtureOnly);
      return { kind: "resolved", cwd: await preflight(input.executionTargetId, input.cwd, signal) };
    },
  };

  const closeForDisconnect = async (id: string) => {
    if (!isFixtureTarget(id) || !attached) return;
    const { key, lease } = attached;
    const route = await owners().get(key);
    if (route?.target !== targetId || route.resourceId !== lease || route.state === "terminal")
      return;
    await native.runtimeForTarget(id)?.localSshClient?.close(route);
  };

  return { wrapPtyAdapter, cwdOwner, preflight, closeForDisconnect, quitCloser };
}

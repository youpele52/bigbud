import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { makeNativeDirectSshQuitCloser } from "../terminal-host/localTerminalHost.directSsh.owner.quit.ts";
import { NativeSshPtyHostLostError, type PtyAdapterShape } from "../terminal/Services/PTY.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.client.ts";
import type { SshOwnerTargetDescriptor } from "./sshOwnerProductionClient.launch.ts";
import type { SshOwnerProductionRegistration } from "./sshOwnerProductionRegistry.ts";
import {
  isProductionDirectSshTarget,
  makeProductionTerminalPort,
  withProductionTerminalOwner,
} from "./sshOwnerProductionTerminal.ts";
import { makeLazySshOwnerProductionTerminal } from "./sshOwnerProductionTerminal.lazy.ts";

const target = "ssh:host=10.0.0.5&user=dev&transport=direct-ssh";
const epoch = new Uint8Array(32).fill(1);
const generation = new Uint8Array(32).fill(2);
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

function registration(overrides: { descriptorTarget?: string } = {}) {
  let next = 10;
  const terminals = new Map<string, boolean>();
  const bound = {
    prepareProofTerminal: vi.fn(async (_input: { readonly shell?: string }) => ({
      lease: new Uint8Array(32).fill(next++),
      ownerEpoch: epoch,
      targetGeneration: generation,
    })),
    proofTerminalStatus: vi.fn(async (lease: Uint8Array) => ({
      lease,
      pid: 7,
      live: terminals.get(hex(lease)) ?? true,
      sample: new Uint8Array(),
      birthGeneration: generation,
    })),
    closeProofTerminal: vi.fn(async (lease: Uint8Array) => {
      terminals.set(hex(lease), false);
      return { lease, pid: 7, live: false, sample: new Uint8Array(), birthGeneration: generation };
    }),
  };
  const descriptor = { targetId: overrides.descriptorTarget ?? target } as SshOwnerTargetDescriptor;
  const value = {
    handle: { target: vi.fn(() => bound), ownerEpoch: epoch, state: () => "open" },
    descriptorFor: vi.fn(async () => descriptor),
  } as unknown as SshOwnerProductionRegistration;
  return { value, bound };
}

const open = (shell?: string) => ({
  pane: { threadId: "thread", terminalId: "pane" },
  targetId: target,
  cwd: "/home/dev/work",
  cols: 80,
  rows: 24,
  ...(shell ? { shell } : {}),
});

describe("production direct-SSH terminals", () => {
  it("routes only direct SSH targets; remote-agent terminals keep their own route (U6)", () => {
    expect(isProductionDirectSshTarget(target)).toBe(true);
    expect(isProductionDirectSshTarget("ssh:host=a&transport=agent")).toBe(false);
    expect(isProductionDirectSshTarget("local")).toBe(false);
  });

  it("treats a missing owner as host loss and a foreign descriptor as a mismatch", async () => {
    await expect(
      withProductionTerminalOwner(
        () => undefined,
        target,
        async () => 1,
      ),
    ).rejects.toBeInstanceOf(NativeSshPtyHostLostError);
    const foreign = registration({ descriptorTarget: "ssh:host=other" });
    await expect(
      withProductionTerminalOwner(
        () => foreign.value,
        target,
        async () => 1,
      ),
    ).rejects.toMatchObject({ code: "targetMismatch" });
    const lost = registration();
    await expect(
      withProductionTerminalOwner(
        () => lost.value,
        target,
        async () => {
          throw new PickerProofOwnerError("ownerUnavailable");
        },
      ),
    ).rejects.toBeInstanceOf(NativeSshPtyHostLostError);
  });

  it("keeps one adapter per lease, carries the U16 shell and retires a confirmed exit", async () => {
    const live = registration();
    const port = makeProductionTerminalPort(() => live.value);
    const signal = new AbortController().signal;
    const first = await port.prepareOpen(open("/usr/bin/zsh"), signal);
    expect(live.bound.prepareProofTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ shell: "/usr/bin/zsh", cwd: "/home/dev/work" }),
    );
    const second = await port.prepareOpen(open(), signal);
    expect(first.leaseId).not.toBe(second.leaseId);
    expect(port.liveLeases()).toBe(2);
    // An unknown lease is adopted attach-only, never opened.
    const retained = { ...first, leaseId: "ab".repeat(32) };
    await expect(port.open(open(), retained, signal)).rejects.toThrow();
    expect((await port.status(retained, signal)).state).toBe("live");
    expect(port.liveLeases()).toBe(3);
    expect((await port.close(retained, signal)).state).toBe("exited");
    expect(port.liveLeases()).toBe(2);
  });

  it("refuses a direct SSH spawn typed while no owner is live and delegates the rest", async () => {
    const original = {
      spawn: vi.fn(() => Effect.die("delegated")),
      ownedRuntimeForTarget: vi.fn(() => undefined),
    } as unknown as PtyAdapterShape;
    const lazy = makeLazySshOwnerProductionTerminal({
      read: () => undefined,
      owners: () => ({}) as RemoteAgentOwnerStore,
      targets: async () => [],
    });
    const adapter = lazy.wrapPtyAdapter(original);
    const input = { shell: "", cwd: "/", cols: 80, rows: 24, env: {} };
    const failure = await Effect.runPromise(
      Effect.flip(adapter.spawn({ ...input, executionTargetId: target })),
    );
    expect(failure).toMatchObject({ message: expect.stringContaining("sshOwnerUnavailable") });
    expect(original.spawn).not.toHaveBeenCalled();
    expect(adapter.ownedRuntimeForTarget?.(target)).toBeUndefined();
    await expect(
      Effect.runPromise(adapter.spawn({ ...input, executionTargetId: "local" })),
    ).rejects.toThrow();
    expect(original.spawn).toHaveBeenCalledOnce();
  });

  it("snapshots the live target set only when quit runs", async () => {
    const targets = vi.fn(async () => [target]);
    const listTerminalOwners = vi.fn(async () => ({ owners: [], nextCursor: undefined }));
    const closer = makeNativeDirectSshQuitCloser({
      targets,
      owners: () => ({ listTerminalOwners }) as unknown as RemoteAgentOwnerStore,
      lifecycle: { close: vi.fn() } as never,
    });
    expect(closer.hasHosts()).toBe(true);
    expect(targets).not.toHaveBeenCalled();
    expect(await closer.closeAll({ reason: "quit", managedOnly: true })).toEqual({
      closed: 0,
      unreachable: 0,
    });
    expect(listTerminalOwners).toHaveBeenCalledWith(target, "", 100);
  });
});

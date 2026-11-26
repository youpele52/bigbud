import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import { profileOwner } from "../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { OwnedPtyHostGenerations } from "../terminal/Services/OwnedPtyRuntime.ts";
import { makeLocalTerminalHostSshClient } from "./localTerminalHost.directSsh.client.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

type Entry = { ptyId: string; state: string; verifiedExit?: boolean; lost?: boolean };

type Generation = Awaited<ReturnType<OwnedPtyHostGenerations["inventory"]>>[number];

function setup(
  input: { entries?: Entry[]; unreachable?: boolean; epoch?: string; others?: Generation[] } = {},
) {
  const base = profileOwner();
  const owner: RemoteAgentOwner = {
    ...base,
    ownerKey: `terminal:${JSON.stringify(["thread", "ssh"])}`,
    target: LOCAL_TERMINAL_HOST_TARGET_ID,
    connectionId: "state-1",
    epoch: "epoch-1",
    resourceId: "pty-ssh",
    state: "may-have-been-sent",
  };
  const binding = {
    runtime: base.runtime,
    expectedEpoch: input.epoch ?? "epoch-1",
    connectionId: "state-1",
  } as RemoteAgentRuntimeBinding;
  const rows = new Map([[owner.ownerKey, owner]]);
  let pins = [{ owner: `${owner.ownerKey}:${owner.resourceId}` }, { owner: "other" }];
  let entries = input.entries ?? [{ ptyId: "pty-ssh", state: "running" }];
  const closed: string[] = [];
  const client = makeLocalTerminalHostSshClient({
    controller: {
      attachedBindings: async () => [{ generation: 1, binding, admitted: true }],
    },
    pool: { getBound: async () => Promise.reject(new Error("unused")) },
    owners: () =>
      ({
        update: async (key: string, change: (value: RemoteAgentOwner) => RemoteAgentOwner) => {
          const next = change(rows.get(key)!);
          rows.set(key, next);
          return next;
        },
      }) as unknown as RemoteAgentOwnerStore,
    control: async () =>
      ({
        registry: {
          update: async (change: (state: { revision: number; pins: typeof pins }) => unknown) => {
            const next = change({ revision: 1, pins }) as { pins: typeof pins };
            pins = next.pins;
          },
        },
      }) as never,
    inventory: vi.fn(async () => {
      const generation = { connectionId: "state-1", expectedEpoch: input.epoch ?? "epoch-1" };
      if (input.unreachable)
        return [{ status: "unreachable" as const, ...generation, cause: "host unreachable" }];
      return [
        {
          status: "ok" as const,
          ...generation,
          entries: entries.map((entry) => ({
            ...entry,
            connectionId: "state-1",
            lost: entry.lost === true,
            lifecycleManaged: true,
          })),
        },
        ...(input.others ?? []),
      ];
    }),
    closePty: vi.fn(async (_binding, ptyId: string) => {
      closed.push(ptyId);
      // An unreaped child stays outcome-unknown after the escalation.
      const entry = entries.find((candidate) => candidate.ptyId === ptyId);
      if (entry?.state === "running") Object.assign(entry, { state: "closed", verifiedExit: true });
    }),
  });
  return {
    client,
    owner,
    rows,
    closed,
    pins: () => pins,
    setEntries: (next: Entry[]) => (entries = next),
  };
}

describe("Direct SSH host PTY liveness", () => {
  it("is live while the host runs it and gone once it ended or is no longer listed", async () => {
    const f = setup();
    expect(await f.client.status(f.owner)).toBe("live");
    f.setEntries([{ ptyId: "pty-ssh", state: "exited", verifiedExit: true }]);
    expect(await f.client.status(f.owner)).toBe("gone");
    f.setEntries([]);
    expect(await f.client.status(f.owner)).toBe("gone");
    // A crashed host lost the PTY with its master.
    f.setEntries([{ ptyId: "pty-ssh", state: "outcome-unknown", lost: true }]);
    expect(await f.client.status(f.owner)).toBe("gone");
  });

  it("is unknown while the host is unreachable, on another epoch, or the child is unreaped", async () => {
    expect(await setup({ unreachable: true }).client.status(setup().owner)).toBe("unknown");
    const otherEpoch = setup({ epoch: "epoch-2" });
    expect(await otherEpoch.client.status(otherEpoch.owner)).toBe("unknown");
    const unreaped = setup({ entries: [{ ptyId: "pty-ssh", state: "outcome-unknown" }] });
    expect(await unreaped.client.status(unreaped.owner)).toBe("unknown");
    const f = setup();
    expect(await f.client.status({ ...f.owner, connectionId: "state-9" })).toBe("unknown");
  });

  it("answers per generation: an unreachable one is unknown even when another is reachable", async () => {
    const f = setup({
      others: [
        { status: "unreachable", connectionId: "state-2", expectedEpoch: "epoch-2", cause: "eof" },
      ],
    });
    expect(await f.client.status(f.owner)).toBe("live");
    expect(await f.client.status({ ...f.owner, connectionId: "state-2", epoch: "epoch-2" })).toBe(
      "unknown",
    );
    // A PTY on another target never belongs to the local host.
    expect(await f.client.status({ ...f.owner, target: "ssh:host=x" })).toBe("unknown");
  });
});

describe("Direct SSH host PTY close", () => {
  it("terminates, confirms the exit, then releases the owner row and its build pin", async () => {
    const f = setup();
    await f.client.close(f.owner);
    expect(f.closed).toEqual(["pty-ssh"]);
    expect(f.rows.get(f.owner.ownerKey)?.state).toBe("terminal");
    expect(f.pins()).toEqual([{ owner: "other" }]);
  });

  it("refuses when the exit cannot be confirmed, keeping the owner row", async () => {
    const f = setup({ entries: [{ ptyId: "pty-ssh", state: "outcome-unknown" }] });
    await expect(f.client.close(f.owner)).rejects.toThrow(/confirm/);
    expect(f.rows.get(f.owner.ownerKey)?.state).toBe("may-have-been-sent");
    const unreachable = setup({ unreachable: true });
    await expect(unreachable.client.close({ ...f.owner, epoch: "epoch-0" })).rejects.toThrow(
      /unreachable/,
    );
  });
});

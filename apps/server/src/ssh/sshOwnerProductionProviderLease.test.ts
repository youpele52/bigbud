import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import type { PickerProofProductionProviderClient } from "./sshOwnerPickerProof.client.productionProvider.ts";
import {
  readProviderLeaseState,
  writeProviderLease,
  type ProviderLeaseState,
} from "./sshOwnerPickerProof.codec.providerLease.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import { startProductionProviderLease } from "./sshOwnerProductionProviderLease.ts";

const scope = { provider: "pi", threadId: "thread-1", sessionEpoch: 1, cwd: "/srv/work" } as const;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("provider lease codec", () => {
  it("refuses operands the owner would refuse, before any round trip", () => {
    const write = (operation: Parameters<typeof writeProviderLease>[1]) =>
      writeProviderLease(new WireWriter(), operation);
    expect(() => write({ kind: "providerProbe", scope: { ...scope, cwd: "/" } })).toThrow(
      PickerProofOwnerError,
    );
    expect(() =>
      write({ kind: "providerProbe", scope: { ...scope, defaultModeUserInput: true } }),
    ).toThrow(PickerProofOwnerError);
    expect(() =>
      write({
        kind: "providerLeaseOpen",
        lease: new Uint8Array(32),
        scope: { ...scope, defaultModeUserInput: true },
      }),
    ).toThrow(PickerProofOwnerError);
    expect(() => write({ kind: "providerLeaseStatus", lease: new Uint8Array(31) })).toThrow(
      PickerProofOwnerError,
    );
    write({
      kind: "providerLeaseOpen",
      lease: new Uint8Array(32),
      scope: { ...scope, provider: "codex", defaultModeUserInput: true },
    });
  });

  it("rejects a listening state without both distinct sockets", () => {
    const encode = (fields: (writer: WireWriter) => void) => {
      const writer = new WireWriter();
      writer.fieldBytes(1, new Uint8Array(32).fill(7));
      fields(writer);
      return writer.finish();
    };
    const listening = encode((writer) => {
      writer.fieldUint(2, 1);
      writer.fieldString(3, "/tmp/a/s");
      writer.fieldString(4, "/tmp/b/s");
    });
    expect(readProviderLeaseState(listening)).toMatchObject({ phase: "listening" });
    for (const invalid of [
      encode((writer) => {
        writer.fieldUint(2, 1);
        writer.fieldString(3, "/tmp/a/s");
      }),
      encode((writer) => {
        writer.fieldUint(2, 1);
        writer.fieldString(3, "/tmp/a/s");
        writer.fieldString(4, "/tmp/a/s");
      }),
      encode((writer) => {
        writer.fieldUint(2, 2);
        writer.fieldUint(5, 1);
      }),
    ])
      expect(() => readProviderLeaseState(invalid)).toThrow(PickerProofOwnerError);
    expect(
      readProviderLeaseState(
        encode((writer) => {
          writer.fieldUint(2, 3);
          writer.fieldUint(5, 2);
        }),
      ),
    ).toMatchObject({ phase: "exited", exitCode: 2 });
  });
});

/** A fake owner: two real Unix sockets and an in-memory lease phase. */
function fakeOwner() {
  const dir = mkdtempSync(join(tmpdir(), "bb-provider-lease-"));
  const paths = [join(dir, "io"), join(dir, "err")] as const;
  const accepted: Socket[] = [];
  const servers: Server[] = paths.map((path, index) => {
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      accepted[index] = socket;
    });
    server.listen(path);
    return server;
  });
  cleanups.push(() => {
    for (const server of servers) server.close();
    for (const socket of accepted) socket.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  let phase: ProviderLeaseState["phase"] = "listening";
  let exitCode = 0;
  const calls: string[] = [];
  const state = (lease: Uint8Array): ProviderLeaseState =>
    phase === "listening"
      ? { lease, phase, stdioSocketPath: paths[0], stderrSocketPath: paths[1] }
      : phase === "exited"
        ? { lease, phase, exitCode }
        : { lease, phase };
  const client: Pick<
    PickerProofProductionProviderClient,
    "openProviderLease" | "providerLeaseStatus" | "closeProviderLease"
  > = {
    openProviderLease: async (lease) => {
      calls.push("open");
      return state(lease);
    },
    providerLeaseStatus: async (lease) => {
      calls.push("status");
      return state(lease);
    },
    closeProviderLease: async (lease) => {
      calls.push("close");
      if (phase === "listening" || phase === "running") phase = "closed";
      for (const socket of accepted) socket.destroy();
      return state(lease);
    },
  };
  const ready = () =>
    new Promise<void>((resolve) => {
      const poll = () => (accepted[0] && accepted[1] ? resolve() : setTimeout(poll, 5));
      poll();
    });
  return {
    client,
    calls,
    accepted,
    ready,
    exit(code: number) {
      phase = "exited";
      exitCode = code;
      for (const socket of accepted) socket.end();
    },
    run() {
      phase = "running";
    },
  };
}

describe("startProductionProviderLease", () => {
  it("carries bytes both ways and settles exit only after the pipes end", async () => {
    const owner = fakeOwner();
    const start = startProductionProviderLease(owner.client, scope);
    const session = await start.ready;
    await owner.ready();
    owner.run();
    const [remoteIo, remoteErr] = owner.accepted as [Socket, Socket];
    const received = new Promise<string>((resolve) =>
      remoteIo.once("data", (d) => resolve(`${d}`)),
    );
    session.stdin.write("ping\n");
    expect(await received).toBe("ping\n");
    const out = new Promise<string>((resolve) =>
      session.stdout.once("data", (d) => resolve(`${d}`)),
    );
    const err = new Promise<string>((resolve) =>
      session.stderr.once("data", (d) => resolve(`${d}`)),
    );
    remoteIo.write("pong\n");
    remoteErr.write("diag\n");
    expect(await out).toBe("pong\n");
    expect(await err).toBe("diag\n");
    expect(owner.calls).toEqual(["open"]);
    session.stdin.end();
    owner.exit(3);
    await expect(session.exit).resolves.toEqual({ kind: "exited", code: 3 });
    // A settled lease needs no second close.
    await start.cancel();
    expect(owner.calls.filter((call) => call === "close")).toHaveLength(0);
  });

  it("confirms a cancel before ready without leaving a pending start", async () => {
    const owner = fakeOwner();
    const start = startProductionProviderLease(owner.client, scope);
    await start.cancel();
    await expect(start.ready).rejects.toBeInstanceOf(PickerProofOwnerError);
    expect(owner.calls).toContain("close");
  });

  it("reports a refused open as a confirmed no-op cancel", async () => {
    const start = startProductionProviderLease(
      {
        openProviderLease: async () => {
          throw new PickerProofOwnerError("providerExecutableUnavailable");
        },
        providerLeaseStatus: async () => {
          throw new Error("unreachable");
        },
        closeProviderLease: async () => {
          throw new Error("unreachable");
        },
      },
      scope,
    );
    await expect(start.ready).rejects.toMatchObject({ code: "providerExecutableUnavailable" });
    await expect(start.cancel()).resolves.toBeUndefined();
  });
});

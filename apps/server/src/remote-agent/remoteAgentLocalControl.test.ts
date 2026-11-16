import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeRemoteAgentInstallOperations } from "./remoteAgentInstall.operation.ts";
import {
  RemoteAgentBackendUnavailableError,
  sendRemoteAgentControlRequest,
  resolveRemoteAgentControlSocket,
  waitForRemoteAgentOperation,
} from "./remoteAgentLocalControl.client.ts";
import { makeRemoteAgentControlHandler } from "./remoteAgentLocalControl.handlers.ts";
import {
  isRemoteAgentOperationSnapshot,
  parseRemoteAgentControlRequest,
  remoteAgentControlSocketPath,
} from "./remoteAgentLocalControl.protocol.ts";
import { startRemoteAgentLocalControlServer } from "./remoteAgentLocalControl.server.ts";
import { resolveRemoteAgentTarget } from "./remoteAgentLocalControl.targets.ts";

const saved = "ssh:host=vps&user=dev&transport=agent";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

async function startFixture(hasManagedBuild = async () => false) {
  // Short base path: Unix socket paths are length-limited.
  const stateDir = mkdtempSync(join(tmpdir(), "bb-"));
  directories.push(stateDir);
  const stage = vi.fn(async () => ({ version: "0.3.4" }));
  const operations = makeRemoteAgentInstallOperations({
    stage,
    activate: async () => ({ currentVersion: "0.3.4" }),
    retire: async () => ({ deferred: 0 }),
  });
  const socketPath = remoteAgentControlSocketPath(stateDir);
  const server = await startRemoteAgentLocalControlServer({
    socketPath,
    handle: makeRemoteAgentControlHandler({
      operations,
      listSavedTargets: async () => [{ executionTargetId: saved, deleted: false }],
      hasManagedBuild,
      status: async () => ({ status: "ready", agentVersion: "0.3.4" }),
      doctor: async () => ({ platform: "linux" }),
    }),
  });
  return { socketPath, server, stage, stateDir };
}

function rawRequest(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => socket.end(payload));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("close", () => resolve(reply));
    socket.on("error", reject);
  });
}

describe("remote agent local control socket", () => {
  it("creates an owner-only directory and socket and serves the allow-listed methods", async () => {
    const fixture = await startFixture();
    try {
      expect(statSync(join(fixture.stateDir, "control")).mode & 0o777).toBe(0o700);
      expect(statSync(fixture.socketPath).mode & 0o777).toBe(0o600);
      const status = await sendRemoteAgentControlRequest(
        fixture.socketPath,
        { method: "status", target: "dev@vps" },
        5_000,
      );
      expect(status).toMatchObject({
        ok: true,
        result: { executionTargetId: saved, approved: true, health: { status: "ready" } },
      });
      const install = await sendRemoteAgentControlRequest(
        fixture.socketPath,
        { method: "install", target: "vps", replace: true, consent: false },
        5_000,
      );
      expect(install.ok && isRemoteAgentOperationSnapshot(install.result)).toBe(true);
      const operationId = (install as { result: { operationId: string } }).result.operationId;
      const finished = await waitForRemoteAgentOperation(fixture.socketPath, operationId);
      expect(finished).toMatchObject({ ok: true, result: { outcome: "active", kind: "replace" } });
    } finally {
      await fixture.server.close();
    }
  });

  it("requires consent for unapproved hosts and never starts an operation without it", async () => {
    const fixture = await startFixture();
    try {
      const unsaved = "ssh:host=other&transport=agent";
      const refused = await sendRemoteAgentControlRequest(
        fixture.socketPath,
        { method: "install", target: unsaved, replace: false, consent: false },
        5_000,
      );
      expect(refused).toMatchObject({ ok: true, result: { status: "consent-required" } });
      expect(fixture.stage).not.toHaveBeenCalled();
    } finally {
      await fixture.server.close();
    }
  });

  it("rejects malformed, oversized, unsupported and command-like requests", async () => {
    const fixture = await startFixture();
    try {
      expect(await rawRequest(fixture.socketPath, "not json\n")).toContain("not valid JSON");
      expect(await rawRequest(fixture.socketPath, `${"x".repeat(70_000)}\n`)).toContain("64 KiB");
      expect(
        await rawRequest(fixture.socketPath, `${JSON.stringify({ v: 1, method: "shutdown" })}\n`),
      ).toContain("unsupported-method");
      expect(
        await rawRequest(
          fixture.socketPath,
          `${JSON.stringify({ v: 1, method: "status", target: "vps; rm -rf ~" })}\n`,
        ),
      ).toContain("saved target ID or an SSH host alias");
    } finally {
      await fixture.server.close();
    }
  });

  it("reports an unavailable backend and refuses to replace a non-socket file", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bb-"));
    directories.push(stateDir);
    const socketPath = remoteAgentControlSocketPath(stateDir);
    await expect(
      sendRemoteAgentControlRequest(socketPath, { method: "status", target: "vps" }, 1_000),
    ).rejects.toBeInstanceOf(RemoteAgentBackendUnavailableError);
    const fixture = await startFixture();
    await fixture.server.close();
    writeFileSync(fixture.socketPath, "not a socket");
    await expect(
      startRemoteAgentLocalControlServer({ socketPath: fixture.socketPath, handle: vi.fn() }),
    ).rejects.toThrow("is not a socket");
  });
});

describe("remote agent control parsing and target resolution", () => {
  it("rejects unknown fields and bounds operation waits", () => {
    expect(parseRemoteAgentControlRequest({ v: 1, method: "status", target: "a", x: 1 })).toEqual({
      error: "Request contains unsupported fields.",
    });
    expect(
      parseRemoteAgentControlRequest({
        v: 1,
        method: "operation",
        operationId: "00000000-0000-4000-8000-000000000000",
        waitMs: 999_999,
      }),
    ).toMatchObject({ waitMs: 25_000 });
  });

  it("resolves exact IDs and unambiguous aliases only", () => {
    const targets = [
      { executionTargetId: saved, deleted: false },
      { executionTargetId: "ssh:host=vps&user=root&transport=agent", deleted: false },
      { executionTargetId: "ssh:host=gone&transport=agent", deleted: true },
      { executionTargetId: "ssh:host=direct&transport=direct-ssh", deleted: false },
    ];
    expect(resolveRemoteAgentTarget("dev@vps", targets)).toEqual({
      ok: true,
      executionTargetId: saved,
      saved: true,
    });
    expect(resolveRemoteAgentTarget("vps", targets)).toMatchObject({ ok: false });
    expect(resolveRemoteAgentTarget("gone", targets)).toMatchObject({ ok: false });
    expect(resolveRemoteAgentTarget("direct", targets)).toMatchObject({ ok: false });
  });
});

describe("remote agent control connection bounds", () => {
  it("destroys connections whose handlers never settle after the hard lifetime", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bb-"));
    directories.push(stateDir);
    const socketPath = remoteAgentControlSocketPath(stateDir);
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const server = await startRemoteAgentLocalControlServer({
      socketPath,
      handle: () => {
        admitted();
        return new Promise(() => {});
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const socket = connect(socketPath);
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    try {
      socket.on("connect", () =>
        socket.write(`${JSON.stringify({ v: 1, method: "status", target: "vps" })}\n`),
      );
      await admission;
      await vi.advanceTimersByTimeAsync(34_999);
      expect(socket.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
      socket.destroy();
      await server.close();
    }
  });

  it("permits a 25-second operation poll admitted just before the five-second deadline", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bb-"));
    directories.push(stateDir);
    const socketPath = remoteAgentControlSocketPath(stateDir);
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const server = await startRemoteAgentLocalControlServer({
      socketPath,
      handle: async () => {
        admit();
        await new Promise((resolve) => setTimeout(resolve, 25_000));
        return { v: 1, ok: true, result: "still running" };
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const socket = connect(socketPath);
    const connected = new Promise<void>((resolve) => socket.on("connect", resolve));
    const reply = new Promise<string>((resolve) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        data += chunk;
      });
      socket.on("close", () => resolve(data));
    });
    try {
      await connected;
      await vi.advanceTimersByTimeAsync(4_999);
      socket.write(
        `${JSON.stringify({ v: 1, method: "operation", operationId: "00000000-0000-4000-8000-000000000000", waitMs: 25_000 })}\n`,
      );
      await admitted;
      await vi.advanceTimersByTimeAsync(25_000);
      expect(JSON.parse(await reply)).toEqual({ v: 1, ok: true, result: "still running" });
    } finally {
      vi.useRealTimers();
      socket.destroy();
      await server.close();
    }
  });

  it("flushes a complete large reply before destroying the connection", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bb-"));
    directories.push(stateDir);
    const socketPath = remoteAgentControlSocketPath(stateDir);
    const result = "x".repeat(512_000);
    const server = await startRemoteAgentLocalControlServer({
      socketPath,
      handle: async () => ({ v: 1, ok: true, result }),
    });
    try {
      expect(
        await sendRemoteAgentControlRequest(socketPath, { method: "status", target: "vps" }, 2_000),
      ).toEqual({ v: 1, ok: true, result });
    } finally {
      await server.close();
    }
  });

  it("caps admission at 16 and releases slots after replying to clients that keep writing open", async () => {
    const fixture = await startFixture();
    const sockets: Socket[] = [];
    try {
      for (let i = 0; i < 16; i++) {
        await new Promise<void>((resolve, reject) => {
          const socket = connect({ path: fixture.socketPath, allowHalfOpen: true }, resolve);
          sockets.push(socket);
          socket.on("error", reject);
        });
      }
      const refused = await sendRemoteAgentControlRequest(
        fixture.socketPath,
        { method: "status", target: "vps" },
        1_000,
      );
      expect(refused).toMatchObject({ ok: false, error: { code: "busy" } });
      const reply = await new Promise<string>((resolve) => {
        let data = "";
        const socket = sockets[0]!;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          data += chunk;
        });
        socket.on("end", () => resolve(data));
        socket.write(`${JSON.stringify({ v: 1, method: "status", target: "vps" })}\n`);
      });
      expect(JSON.parse(reply)).toMatchObject({ ok: true });
      expect(
        await sendRemoteAgentControlRequest(
          fixture.socketPath,
          { method: "status", target: "vps" },
          1_000,
        ),
      ).toMatchObject({ ok: true });
    } finally {
      for (const socket of sockets) socket.destroy();
      await fixture.server.close();
    }
  });

  it("rejects an incomplete request at the five-second admission deadline", async () => {
    const fixture = await startFixture();
    const started = Date.now();
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect(fixture.socketPath, () => socket.write('{"v":1'));
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          data += chunk;
        });
        socket.on("close", () => resolve(data));
        socket.on("error", reject);
      });
      expect(JSON.parse(reply)).toMatchObject({
        ok: false,
        error: { message: "Request was not received in time." },
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      await fixture.server.close();
    }
  });
});

describe("remote-agent CLI state directory", () => {
  it.each(["beta", "preview", "nightly"])("uses the bundled %s identity", (channel) => {
    expect(
      resolveRemoteAgentControlSocket({
        development: false,
        environment: {},
        version: `1.2.3-${channel}.1`,
      }),
    ).toBe(
      remoteAgentControlSocketPath(join(homedir(), ".bigbud", "channels", channel, "userdata")),
    );
    expect(
      resolveRemoteAgentControlSocket({
        baseDir: "/explicit",
        development: false,
        environment: {},
        version: `1.2.3-${channel}.1`,
      }),
    ).toBe(remoteAgentControlSocketPath("/explicit/userdata"));
  });

  it("reports a live backend with an unavailable control channel", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bb-"));
    directories.push(stateDir);
    writeFileSync(
      join(stateDir, "backend.lock"),
      JSON.stringify({
        format: "bigbud.backend-lock.v1",
        pid: process.pid,
        startedAt: null,
        port: 1234,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
        nonce: "test",
      }),
      { mode: 0o600 },
    );
    await expect(
      sendRemoteAgentControlRequest(
        remoteAgentControlSocketPath(stateDir),
        { method: "status", target: "vps" },
        1_000,
      ),
    ).rejects.toThrow(
      "the bigbud backend is running but its command-line control channel is unavailable (see logs)",
    );
  });
});

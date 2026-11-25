import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { DEV_SSH_OWNER_PROFILE_PREFIX } from "@bigbud/shared/DevLauncher";
import { Effect, Schema } from "effect";
import { expect, it, vi } from "vitest";

import { withBaselineServer } from "../server.sshOwnerBaseline.fixture.ts";
import { attemptRawUpgrade } from "../server.test.remote.ts";
import { withWsRpcClient, type WsRpcClient } from "../server.test.rpc.ts";
import { REMOTE_TARGET_DISCONNECTED_MESSAGE } from "./sshTargetDisconnects.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const host = "127.0.0.1";
const entry = fileURLToPath(new URL("../bin.ts", import.meta.url));
const preload = fileURLToPath(
  new URL("./sshOwnerPickerProof.backendRestart.preload.ts", import.meta.url),
);
const defaultOwner = fileURLToPath(
  new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url),
);
const target = {
  executionTargetId: "ssh:host=rust-ssh-owner-dev&auth=ssh-key&transport=direct-ssh",
};
const folder = { ...target, path: "~/picker's folders; literal" };
const emptyTraffic = { connections: 0, authentications: 0, fallback: [] };

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function readState(dbPath: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      disconnect: db
        .prepare(
          "SELECT disconnected_at FROM remote_execution_target_disconnects WHERE target_id = ?",
        )
        .get(target.executionTargetId),
      writer: db.prepare("SELECT writer_epoch FROM ssh_owner_writer WHERE singleton = 1").get(),
    };
  } finally {
    db.close();
  }
}

async function makeRestartFixture(profile: string) {
  const bun = await realpath(execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8" }).trim());
  const binary = await realpath(process.env.BIGBUD_SSH_OWNER_BIN ?? defaultOwner);
  const ownerSha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  const home = path.join(profile, "home");
  const bin = path.join(profile, "bin");
  const state = path.join(profile, "dev");
  await Promise.all([home, bin, state].map((dir) => mkdir(dir, { mode: 0o700 })));
  // Fail closed even if a legacy launcher bypasses Bun's node:child_process compatibility API.
  await Promise.all(
    ["ssh", "ssh-keygen", "ssh-keyscan", "ssh-add", "ssh-agent"].map((tool) =>
      writeFile(
        path.join(bin, tool),
        `#!/bin/sh\nprintf '%s\\n' '${tool}' >> "$BIGBUD_TEST_SSH_OWNER_BACKEND_TRACE.fallback"\nexit 91\n`,
        { mode: 0o700 },
      ),
    ),
  );
  await writeFile(
    path.join(state, "settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(
        Object.keys(DEFAULT_SERVER_SETTINGS.providers).map((provider) => [
          provider,
          { enabled: false },
        ]),
      ),
    }),
  );
  const token = randomUUID();
  const port = await reservePort();
  const url = `ws://${host}:${port}/ws`;
  return {
    dbPath: path.join(state, "state.sqlite"),
    ownerSha256,
    url,
    rpc: <A, E>(run: (client: WsRpcClient) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.scoped(withWsRpcClient(`${url}?token=${token}`, run)).pipe(
          Effect.timeout("10 seconds"),
        ),
      ),
    async backend(phase: "first" | "second") {
      const trace = path.join(profile, phase);
      const traceFiles = ["sshd", "children", "fallback"] as const;
      await Promise.all(
        traceFiles.map((name) => writeFile(`${trace}.${name}`, "", { flag: "wx" })),
      );
      const output = (name: (typeof traceFiles)[number]) => readFile(`${trace}.${name}`, "utf8");
      return {
        start: () =>
          spawn(
            bun,
            [
              "run",
              "--no-env-file",
              "--preload",
              preload,
              entry,
              "--mode",
              "desktop",
              "--host",
              host,
              "--port",
              String(port),
              "--base-dir",
              profile,
              "--dev-url",
              "http://127.0.0.1:1",
              "--no-browser",
              "--auth-token",
              token,
            ],
            {
              cwd: profile,
              stdio: ["ignore", "pipe", "pipe"],
              env: {
                HOME: home,
                TMPDIR: profile,
                PATH: bin,
                SHELL: "/bin/sh",
                LC_ALL: "C",
                GIT_CONFIG_NOSYSTEM: "1",
                BIGBUD_TELEMETRY_ENABLED: "false",
                BIGBUD_DISABLE_CLIPROXY: "1",
                BIGBUD_REMOTE_MOBILE_ENABLED: "false",
                BIGBUD_TERMINAL_HOST: "0",
                BIGBUD_SSH_OWNER: "1",
                BIGBUD_SSH_OWNER_BIN: binary,
                BIGBUD_SSH_OWNER_NORMAL_DEV_READY: "1",
                BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE: profile,
                BIGBUD_TEST_SSH_OWNER_BACKEND_TRACE: trace,
              },
            },
          ),
        sshdLog: () => output("sshd"),
        children: async () => (await output("children")).trim().split("\n").filter(Boolean),
        traffic: async () => {
          const [sshd, fallback] = await Promise.all([output("sshd"), output("fallback")]);
          return {
            connections: sshd.match(/^Connection from /gm)?.length ?? 0,
            authentications: sshd.match(/^Accepted publickey /gm)?.length ?? 0,
            fallback: fallback.trim().split("\n").filter(Boolean),
          };
        },
      };
    },
  };
}

type RestartFixture = Awaited<ReturnType<typeof makeRestartFixture>>;

type BackendTrace = Awaited<ReturnType<RestartFixture["backend"]>>;

async function selectedFixture(fixture: RestartFixture, trace: BackendTrace) {
  const config = await fixture.rpc((client) => client[WS_METHODS.serverListSshConfigHosts]({}));
  expect(config.developmentOwnerTargetId).toBe(target.executionTargetId);
  expect(config.hosts).toHaveLength(1);
  const selected = config.hosts[0];
  if (!selected || !/^\/private\/tmp\/bigbud-picker-sshd-[A-Za-z0-9]+$/.test(selected.sourcePath)) {
    throw new Error("Unexpected selected DEV fixture path");
  }
  expect(selected).toMatchObject({ alias: "rust-ssh-owner-dev", hostName: host });
  const port = /^Server listening on 127\.0\.0\.1 port (\d+)\.$/m.exec(await trace.sshdLog())?.[1];
  if (!port || Number(port) <= 1024)
    throw new Error("Expected a disposable unprivileged sshd listener");
  const { sourcePath: root } = selected;
  const ownerHash = createHash("sha256")
    .update(await readFile(path.join(root, "picker-owner")))
    .digest("hex");
  expect(ownerHash).toBe(fixture.ownerSha256);
  const knownHosts = path.join(root, "known_hosts");
  const hostKey = (await readFile(path.join(root, "host-key.pub"), "utf8"))
    .split(" ")
    .slice(0, 2)
    .join(" ");
  const exactPin = `[${host}]:${port} ${hostKey}\n`;
  const homePath = path.join(root, "home");
  return {
    root,
    knownHosts,
    exactPin,
    listing: {
      homePath,
      path: path.join(homePath, "picker's folders; literal"),
      folders: [
        { name: "alpha", isGitRepo: false },
        { name: "Z repo", isGitRepo: true },
      ],
      truncated: false,
    },
  };
}

it.skipIf(process.env.BIGBUD_TEST_SSH_OWNER_BACKEND_RESTART !== "1")(
  "S1: preserves selected Rust picker Disconnect across actual Bun backend restart until explicit Connect",
  async () => {
    if (process.platform !== "darwin" || process.getuid?.() === 0) {
      throw new Error("S1 backend restart requires the disposable non-root macOS DEV fixture");
    }
    const profile = await mkdtemp(`/private/tmp/${DEV_SSH_OWNER_PROFILE_PREFIX}`);
    try {
      const fixture = await makeRestartFixture(profile);
      const list = (client: WsRpcClient) => client[WS_METHODS.serverListRemoteFolders](folder);
      const disconnected = () =>
        fixture.rpc((client) => client[WS_METHODS.serverListDisconnectedExecutionTargets]({}));
      const blocked = async () => {
        await expect(disconnected()).resolves.toEqual({
          executionTargetIds: [target.executionTargetId],
        });
        await expect(
          fixture.rpc((client) => list(client).pipe(Effect.flip)),
        ).resolves.toMatchObject({
          _tag: "ServerListRemoteFoldersError",
          message: REMOTE_TARGET_DISCONNECTED_MESSAGE,
        });
      };
      const first = await fixture.backend("first");
      const before = await withBaselineServer(first.start(), async (pid) => {
        expect(await attemptRawUpgrade(fixture.url)).toMatchObject({
          upgraded: false,
          status: 401,
        });
        const selected = await selectedFixture(fixture, first);
        expect(await first.traffic()).toEqual(emptyTraffic);
        await expect(disconnected()).resolves.toEqual({ executionTargetIds: [] });
        const unknown = await fixture.rpc((client) => list(client).pipe(Effect.flip));
        expect(unknown.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
        const { challengeId } = Schema.decodeUnknownSync(SshHostTrustChallenge)(
          JSON.parse(unknown.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
        );
        expect(challengeId).toMatch(/^rust-dev:/);
        await expect(
          fixture.rpc((client) =>
            client[WS_METHODS.serverTrustSshHost]({ ...target, challengeId }),
          ),
        ).resolves.toEqual({ message: "SSH host trusted." });
        await expect(readFile(selected.knownHosts, "utf8")).resolves.toBe(selected.exactPin);
        expect(await first.traffic()).toMatchObject({ authentications: 0, fallback: [] });
        await expect(fixture.rpc(list)).resolves.toEqual(selected.listing);
        const traffic = await vi.waitFor(async () => {
          const observed = await first.traffic();
          expect(observed.authentications).toBe(1);
          expect(observed.connections).toBeGreaterThanOrEqual(2); // keyscan + authenticated listing
          expect(observed.fallback).toEqual([]);
          return observed;
        });
        await expect(
          fixture.rpc((client) => client[WS_METHODS.serverDisconnectExecutionTarget](target)),
        ).resolves.toEqual({ ...target, disconnected: true });
        await blocked();
        expect(await first.traffic()).toEqual(traffic);
        return { pid, selected, traffic };
      });
      expect(await first.children()).toEqual([
        expect.stringMatching(/^sshd \d+$/),
        expect.stringMatching(/^start-picker-owner \d+$/),
        "start-picker-owner exited",
        "sshd exited",
      ]);
      const { dev, ino } = await stat(fixture.dbPath);
      const saved = await readState(fixture.dbPath);
      expect(saved).toEqual({
        disconnect: { disconnected_at: expect.any(Number) },
        writer: { writer_epoch: expect.any(String) },
      });

      const second = await fixture.backend("second");
      const after = await withBaselineServer(second.start(), async (pid) => {
        expect(pid).not.toBe(before.pid);
        expect(await stat(fixture.dbPath)).toMatchObject({ dev, ino });
        const selected = await selectedFixture(fixture, second);
        expect(selected.root).not.toBe(before.selected.root);
        expect(selected.exactPin).not.toBe(before.selected.exactPin);
        // The normal DEV backend generates a fresh sshd/key on each boot. Pin only this new
        // disposable key before the blocked read, so neither lack of trust nor a dead listener
        // can explain the negative probe. Connect still has to clear the previous DB flag.
        await expect(readFile(selected.knownHosts, "utf8")).resolves.toBe("");
        await writeFile(selected.knownHosts, selected.exactPin);
        expect(await second.traffic()).toEqual(emptyTraffic);
        await blocked();
        const reopened = await readState(fixture.dbPath);
        expect(reopened).toEqual({
          disconnect: saved.disconnect,
          writer: { writer_epoch: expect.any(String) },
        });
        expect(reopened.writer).not.toEqual(saved.writer);
        // Give delayed work time to run against the listening fixture, then repeat on a new WS.
        await new Promise((resolve) => setTimeout(resolve, 5_100));
        await blocked();
        const restartedBlocked = await second.traffic();
        expect(restartedBlocked).toEqual(emptyTraffic);
        await expect(
          fixture.rpc((client) => client[WS_METHODS.serverConnectExecutionTarget](target)),
        ).resolves.toEqual({ ...target, disconnected: false });
        await expect(disconnected()).resolves.toEqual({ executionTargetIds: [] });
        expect((await readState(fixture.dbPath)).disconnect).toBeUndefined();
        const explicitConnect = await second.traffic();
        expect(explicitConnect).toEqual(emptyTraffic);
        await expect(fixture.rpc(list)).resolves.toEqual(selected.listing);
        await vi.waitFor(async () =>
          expect(await second.traffic()).toEqual({
            connections: 1,
            authentications: 1,
            fallback: [],
          }),
        );
        return { pid, restartedBlocked, explicitConnect };
      });
      expect(await second.children()).toEqual([
        expect.stringMatching(/^sshd \d+$/),
        expect.stringMatching(/^start-picker-owner \d+$/),
        "start-picker-owner exited",
        "sshd exited",
      ]);
      expect(await stat(fixture.dbPath)).toMatchObject({ dev, ino });
      expect((await readState(fixture.dbPath)).disconnect).toBeUndefined();
      console.info("S1 selected Rust picker backend restart", {
        platform: `${process.platform}/${process.arch} (${release()})`,
        backendPids: [before.pid, after.pid],
        sqliteInode: ino,
        ownerSha256: fixture.ownerSha256,
        original: before.traffic,
        restartedBlocked: after.restartedBlocked,
        explicitConnect: after.explicitConnect,
        restartedRead: await second.traffic(),
      });
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
  120_000,
);

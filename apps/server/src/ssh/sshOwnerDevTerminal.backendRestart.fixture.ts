import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { launchRetainedDevSshOwner } from "../../../../scripts/lib/dev-ssh-owner-supervisor.ts";
import net from "node:net";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { withWsRpcClient, type WsRpcClient } from "../server.test.rpc.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const host = "127.0.0.1";
const entry = fileURLToPath(new URL("../bin.ts", import.meta.url));
const preload = fileURLToPath(
  new URL("./sshOwnerPickerProof.backendRestart.preload.ts", import.meta.url),
);
const defaultOwner = fileURLToPath(
  new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url),
);
export const executionTargetId = "ssh:host=rust-ssh-owner-dev&auth=ssh-key&transport=direct-ssh";
export const target = { executionTargetId };
export const pane = { threadId: "c07-backend-restart", terminalId: "native-pty" };
export const key = `terminal:${JSON.stringify([pane.threadId, pane.terminalId])}`;

async function reservePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function setup(profile: string) {
  const bun = await realpath(
    execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8", timeout: 2_000 }).trim(),
  );
  const binary = await realpath(process.env.BIGBUD_SSH_OWNER_BIN ?? defaultOwner);
  const home = path.join(profile, "home");
  const bin = path.join(profile, "bin");
  const state = path.join(profile, "dev");
  await Promise.all([home, bin, state].map((dir) => mkdir(dir, { mode: 0o700 })));
  // Guard both async absolute launches (preload) and tools found via PATH.
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
  const ws = `ws://${host}:${port}/ws`;
  return {
    ws,
    dbPath: path.join(state, "state.sqlite"),
    rpc: <A, E>(run: (client: WsRpcClient) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.scoped(withWsRpcClient(`${ws}?token=${token}`, run)).pipe(
          Effect.timeout("15 seconds"),
        ),
      ),
    async backend(phase: "first" | "second" | "launcher", retain = false, quitChannel = false) {
      const trace = path.join(profile, phase);
      const names = ["children", "sshd", "fallback"] as const;
      await Promise.all(names.map((name) => writeFile(`${trace}.${name}`, "", { flag: "wx" })));
      const output = (name: (typeof names)[number]) => readFile(`${trace}.${name}`, "utf8");
      return {
        startSupervisor: () =>
          launchRetainedDevSshOwner({
            bun,
            profile,
            binary,
            home,
            preload: { path: preload, trace },
          }),
        start() {
          const child = spawn(
            bun,
            ["run", "--no-env-file", "--preload", preload, entry, "--bootstrap-fd", "3"],
            {
              cwd: profile,
              stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
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
                ...(retain ? { BIGBUD_SSH_OWNER_RETAIN: "1" } : {}),
                ...(quitChannel ? { BIGBUD_STARTUP_STATUS_FD: "4" } : {}),
              },
            },
          );
          const bootstrap = child.stdio[3] as Writable;
          bootstrap.on("error", () => child.kill("SIGTERM"));
          bootstrap.end(
            `${JSON.stringify({ mode: "desktop", host, port, t3Home: profile, devUrl: "http://127.0.0.1:1", noBrowser: true, authToken: token, ...(quitChannel ? { lifecycleHintFd: 5 } : {}), ...(phase === "second" ? { startReason: "unexpected-exit-restart" } : {}) })}\n`,
          );
          child.stdio[4]?.on("data", () => {});
          return child;
        },
        children: async () => (await output("children")).trim().split("\n").filter(Boolean),
        traffic: async () => {
          const sshd = await output("sshd");
          return {
            connections: sshd.match(/^Connection from /gm)?.length ?? 0,
            authentications: sshd.match(/^Accepted publickey /gm)?.length ?? 0,
            fallback: await output("fallback"),
          };
        },
      };
    },
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

export async function selectedRoot(fixture: Fixture) {
  const config = await fixture.rpc((client) => client[WS_METHODS.serverListSshConfigHosts]({}));
  expect(config.developmentOwnerTargetId).toBe(executionTargetId);
  expect(config.hosts).toHaveLength(1);
  const selected = config.hosts[0];
  expect(selected).toMatchObject({ alias: "rust-ssh-owner-dev", hostName: host });
  if (!selected || !/^\/private\/tmp\/bigbud-picker-sshd-[A-Za-z0-9]+$/.test(selected.sourcePath)) {
    throw new Error("Unexpected disposable SSH fixture path");
  }
  return selected.sourcePath;
}

export async function trustAndResolveCwd(fixture: Fixture, root: string) {
  const list = (client: WsRpcClient) =>
    client[WS_METHODS.serverListRemoteFolders]({ ...target, path: "~/picker's folders; literal" });
  const unknown = await fixture.rpc((client) => list(client).pipe(Effect.flip));
  expect(unknown.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
  const { challengeId } = Schema.decodeUnknownSync(SshHostTrustChallenge)(
    JSON.parse(unknown.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
  );
  expect(challengeId).toMatch(/^rust-dev:/);
  await expect(
    fixture.rpc((client) => client[WS_METHODS.serverTrustSshHost]({ ...target, challengeId })),
  ).resolves.toEqual({ message: "SSH host trusted." });
  const listed = await fixture.rpc(list);
  expect(listed.path).toBe(path.join(root, "home", "picker's folders; literal"));
  return listed.path;
}

export async function readState(dbPath: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      writer: db.prepare("SELECT writer_epoch FROM ssh_owner_writer WHERE singleton = 1").get(),
      routes: db
        .prepare(
          "SELECT owner_key, route_json, revision FROM remote_agent_runtime_owners ORDER BY owner_key",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTestServerConfig } from "../server.test.app.config.ts";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import {
  RemoteBackendRelayProfiles,
  type ResolvedRemoteBackendRelayProfile,
} from "./clientRelay.profiles.ts";
import { makeRemoteBackendRelayRoute } from "./clientRelay.route.ts";
import { makeClientRelaySshChannels } from "./clientRelay.ssh.ts";

const authorityId = "a".repeat(32);
const nodeSha256 = "b".repeat(64);
const helperSha256 = "c".repeat(64);
const destination = "fixture@127.0.0.1";

// This child only interprets fixture modes and bytes. It never evaluates the SSH command,
// opens a network connection, reads real keys, or invokes a configured SSH helper.
const recorder = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [program, ...argv] = process.argv.slice(2);
const kind = program === 'ssh-keygen' ? 'key' : argv.at(-1) === 'true' ? 'trust' : 'relay';
fs.appendFileSync(path.join(__dirname, 'launches.jsonl'), JSON.stringify({
  kind, argv, pid: process.pid, ppid: process.ppid, image: process.execPath,
  home: process.env.HOME, agentSocket: process.env.SSH_AUTH_SOCK,
  askpassMode: process.env.SSH_ASKPASS_REQUIRE ?? null,
}) + '\n');
const mode = process.env.BB_RELAY_RECORDER_MODE;
if (kind === 'key') {
  if (mode === 'invalid-key') {
    fs.writeSync(2, 'Invalid synthetic key\n');
    process.exitCode = 1;
  }
} else if (kind === 'trust') {
  fs.writeSync(2, mode === 'changed-key'
    ? 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n'
    : 'Permission denied (publickey).\n');
  process.exitCode = 255;
} else if (mode === 'http') {
  let request = '';
  process.stdin.setEncoding('latin1').on('data', (chunk) => {
    request += chunk;
    if (!request.includes('\r\n\r\n') && request.length < 16384) return;
    process.stdin.destroy();
    if (!request.startsWith('GET /asset HTTP/1.1\r\n')) {
      process.exitCode = 2;
      return;
    }
    process.stdout.write('HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n');
    process.stdout.write(Buffer.from([0, 255, 128, 10]));
  });
} else {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    fs.writeSync(2, 'synthetic diagnostic, not relay data\n');
    process.stdout.write(Buffer.concat([...chunks, Buffer.from([253, 0, 254])]));
  });
}
`;

interface Launch {
  readonly kind: "key" | "trust" | "relay";
  readonly argv: string[];
  readonly pid: number;
  readonly ppid: number;
  readonly image: string;
  readonly home: string;
  readonly agentSocket: string;
  readonly askpassMode: string | null;
}

describe.skipIf(process.platform === "win32")("F08/C13 legacy client relay SSH launches", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  async function setup(mode: "binary" | "http" | "invalid-key" | "changed-key") {
    const root = await fs.mkdtemp(join(tmpdir(), "bb-client-relay-"));
    cleanups.push(() => fs.rm(root, { force: true, recursive: true }));
    const home = join(root, "home");
    const bin = join(root, "bin");
    const agentSocket = join(root, "not-an-agent.sock");
    const log = join(bin, "launches.jsonl");
    const keyPath = join(home, "fixture-key");
    await fs.mkdir(home, { mode: 0o700 });
    await fs.mkdir(bin, { mode: 0o700 });
    await fs.writeFile(keyPath, "not a real key", { mode: 0o600 });
    await fs.writeFile(log, "");
    await fs.writeFile(join(bin, "recorder.cjs"), recorder);
    for (const name of ["ssh", "ssh-keygen"]) {
      await fs.writeFile(
        join(bin, name),
        '#!/bin/sh\nexec "$BB_RELAY_RECORDER_NODE" "${0%/*}/recorder.cjs" "${0##*/}" "$@"\n',
        { mode: 0o700 },
      );
    }
    // No system SSH or agent helpers on PATH. HOME, the key, and the agent path are synthetic.
    vi.stubEnv("PATH", bin);
    vi.stubEnv("HOME", home);
    vi.stubEnv("TMPDIR", root);
    vi.stubEnv("SSH_AUTH_SOCK", agentSocket);
    vi.stubEnv("SSH_ASKPASS", undefined);
    vi.stubEnv("SSH_ASKPASS_REQUIRE", undefined);
    vi.stubEnv("NODE_OPTIONS", undefined);
    vi.stubEnv("BB_RELAY_RECORDER_NODE", process.execPath);
    vi.stubEnv("BB_RELAY_RECORDER_MODE", mode);

    const profile: ResolvedRemoteBackendRelayProfile = {
      profile: {
        profileId: "recorded-fixture",
        label: "Synthetic relay",
        identity: {
          authority: { authorityId, keyEpoch: 1, keyFingerprint: `sha256:${nodeSha256}` },
          installationFingerprint: `sha256:${helperSha256}`,
        },
      },
      executionTargetId: `ssh:${new URLSearchParams({ host: "127.0.0.1", user: "fixture", port: "2222", auth: "ssh-key", keyPath })}`,
      deployment: {
        authorityId,
        nodeBinary: "/fixture/Node Runtime/bin/node",
        nodeSha256,
        helperEntry: "/fixture/relay.mjs",
        helperSha256,
      },
    };
    const launches = async () =>
      (await fs.readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Launch);
    const channels = () => {
      const owner = makeClientRelaySshChannels(profile);
      cleanups.push(owner.dispose);
      return owner;
    };
    return { profile, launches, channels, home, agentSocket, keyPath };
  }

  type Fixture = Awaited<ReturnType<typeof setup>>;

  async function expectRelayLaunch(fixture: Fixture) {
    const launches = await fixture.launches();
    expect(launches.map((launch) => launch.kind)).toEqual(["key", "trust", "relay"]);
    for (const launch of launches) {
      expect(launch.pid).toBeGreaterThan(0);
      expect(launch).toMatchObject({
        ppid: process.pid,
        image: process.execPath,
        home: fixture.home,
        agentSocket: fixture.agentSocket,
      });
    }
    const [key, trust, relay] = launches;
    expect(key?.argv).toEqual(["-y", "-P", "", "-f", fixture.keyPath]);
    expect(trust?.askpassMode).toBe("force");
    expect(trust?.argv).toEqual([
      "-T",
      ...[
        "BatchMode=no",
        "StrictHostKeyChecking=ask",
        "FingerprintHash=sha256",
        "UpdateHostKeys=no",
        "ControlPath=none",
        "PreferredAuthentications=none",
        "PubkeyAuthentication=no",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "NumberOfPasswordPrompts=0",
        "ConnectTimeout=10",
        "ConnectionAttempts=1",
      ].flatMap((option) => ["-o", option]),
      "-p",
      "2222",
      "--",
      destination,
      "true",
    ]);
    expect(relay?.askpassMode).toBeNull();
    expect(relay?.argv.slice(0, -1)).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-p",
      "2222",
      "-i",
      fixture.keyPath,
      ...[
        "StrictHostKeyChecking=yes",
        "UpdateHostKeys=no",
        "ClearAllForwardings=yes",
        "PermitLocalCommand=no",
        "ConnectTimeout=10",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
      ].flatMap((option) => ["-o", option]),
      "--",
      destination,
    ]);
    const command = relay?.argv.at(-1);
    expect(command).toMatch(
      /^'\/usr\/bin\/env' '-i' 'PATH=\/usr\/bin:\/bin' 'LC_ALL=C' '\/bin\/sh' '-c' /,
    );
    const { nodeBinary, helperEntry } = fixture.profile.deployment;
    const verifiedExec = [
      `set -eu`,
      `test "$(sha256sum '${nodeBinary}' | cut -d ' ' -f 1)" = '${nodeSha256}'`,
      `test "$(sha256sum '${helperEntry}' | cut -d ' ' -f 1)" = '${helperSha256}'`,
      `exec '${nodeBinary}' '${helperEntry}' '${authorityId}'`,
    ].join("; ");
    expect(
      command?.endsWith(` 'sh' '' '--' '/bin/sh' '-c' '${verifiedExec.replaceAll("'", "'\\''")}'`),
    ).toBe(true);
  }

  function withRoute<A, E>(
    fixture: Fixture,
    configOverrides: Partial<ServerConfigShape>,
    exercise: (
      route: Effect.Success<ReturnType<typeof makeRemoteBackendRelayRoute>>,
    ) => Effect.Effect<A, E>,
    onResolve: () => void = () => {},
  ) {
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* buildTestServerConfig({ config: configOverrides });
          const scope = yield* Effect.scope;
          const route = yield* makeRemoteBackendRelayRoute("recorder", scope).pipe(
            Effect.provideService(ServerConfig, config),
            Effect.provideService(RemoteBackendRelayProfiles, {
              list: async () => ({
                availability: "available",
                profiles: [fixture.profile.profile],
              }),
              resolve: async () => {
                onResolve();
                return fixture.profile;
              },
            }),
          );
          route.lifecycle.ready(async () => new Set([1]));
          return yield* exercise(route);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it("records key readiness, trust and one strict relay launch; binary stdout survives stdin EOF", async () => {
    const fixture = await setup("binary");
    const owner = fixture.channels();
    const stream = await owner.openChannel(AbortSignal.timeout(10_000));
    const payload = Buffer.alloc(512 * 1024);
    for (let index = 0; index < payload.length; index++) payload[index] = index % 256;
    // The recorder writes no stdout until stdin EOF. Wait for the unread response to reach
    // the relay's high-water mark before draining it, rather than racing a fixed sleep.
    stream.end(payload);
    await vi.waitFor(
      () => expect(stream.readableLength).toBeGreaterThanOrEqual(stream.readableHighWaterMark),
      { timeout: 5_000 },
    );
    const received: Buffer[] = [];
    for await (const chunk of stream) received.push(Buffer.from(chunk));
    expect(
      Buffer.concat(received).equals(Buffer.concat([payload, Buffer.from([253, 0, 254])])),
    ).toBe(true);
    await expectRelayLaunch(fixture);
  });

  it.each([
    ["invalid-key", /Failed to read SSH key/, ["key"]],
    ["changed-key", /identity has changed or was revoked/, ["key", "trust"]],
  ] as const)("refuses %s before starting the relay child", async (mode, error, expected) => {
    const fixture = await setup(mode);
    await expect(fixture.channels().openChannel(AbortSignal.timeout(10_000))).rejects.toThrow(
      error,
    );
    expect((await fixture.launches()).map((launch) => launch.kind)).toEqual(expected);
  });

  it("only starts the recorder for an authorized request through an admitted local relay lease", async () => {
    const fixture = await setup("http");
    await withRoute(fixture, { mode: "desktop", authToken: "local-fixture" }, (route) =>
      Effect.gen(function* () {
        const endpoint = yield* route.handlers[WS_METHODS.serverOpenRemoteBackendRelay](
          { profileId: fixture.profile.profile.profileId, requestId: randomUUID() },
          { clientId: 1 },
        );
        expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(yield* Effect.promise(fixture.launches)).toEqual([]);
        const request = (token: string, origin: string) =>
          Effect.promise(() =>
            fetch(`${endpoint.baseUrl}/asset`, {
              headers: {
                authorization: `Bearer ${token}`,
                origin,
                "x-bigbud-client-rpc-revision": "1",
              },
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            }),
          );
        expect(
          (yield* request(endpoint.localCredential, "https://unapproved.invalid")).status,
        ).toBe(403);
        expect((yield* request("wrong-token", "bigbud://app")).status).toBe(401);
        expect(yield* Effect.promise(fixture.launches)).toEqual([]);
        const response = yield* request(endpoint.localCredential, "bigbud://app");
        expect(response.status).toBe(200);
        expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(
          new Uint8Array([0, 255, 128, 10]),
        );
      }),
    );
    await expectRelayLaunch(fixture);
  });

  it.each([
    { mode: "remote", authToken: "local-fixture", clientId: 1, code: "unavailable" },
    { mode: "desktop", authToken: undefined, clientId: 1, code: "unavailable" },
    { mode: "desktop", authToken: "local-fixture", clientId: 2, code: "caller-closed" },
  ] as const)(
    "refuses $mode route with token $authToken and caller $clientId before profile lookup or SSH",
    async ({ mode, authToken, clientId, code }) => {
      const fixture = await setup("http");
      const resolve = vi.fn();
      await expect(
        withRoute(
          fixture,
          { mode, authToken },
          (route) =>
            route.handlers[WS_METHODS.serverOpenRemoteBackendRelay](
              { profileId: fixture.profile.profile.profileId, requestId: randomUUID() },
              { clientId },
            ),
          resolve,
        ),
      ).rejects.toMatchObject({ code });
      expect(resolve).not.toHaveBeenCalled();
      expect(await fixture.launches()).toEqual([]);
    },
  );
});

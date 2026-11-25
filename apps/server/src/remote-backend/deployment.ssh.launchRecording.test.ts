import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { inspectSshHostTrust } from "../ssh/sshHostTrust.ts";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import { makeWsRpcRemoteBackendDeploymentHandlers } from "../ws/wsRpcHandlers.remoteBackendDeployment.ts";
import { RemoteBackendDeployment } from "./Services/RemoteBackendDeployment.ts";
import { makeDeploymentApproval } from "./deployment.approval.ts";
import { runDeploymentSsh } from "./deployment.ssh.ts";
import {
  AUTHORITY,
  INSTALLATION,
  KEY_FINGERPRINT,
  makeDeploymentFixture,
  memoryProfileStore,
  REQUEST,
} from "./deployment.test.helpers.ts";
import { makeRemoteBackendDeployment } from "./deployment.ts";

const input = {
  executionTargetId: "ssh:host=127.0.0.1&user=fixture&port=2222&transport=agent",
  requestId: REQUEST,
  enableBoot: false,
};
const remoteHome = "/home/fixture";
const authority = { authorityId: AUTHORITY, keyFingerprint: KEY_FINGERPRINT, keyEpoch: 1 };
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

// Never evaluates the remote command or opens a socket. Only synthetic argv and stdin shape are kept.
const recorder = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const log = path.join(__dirname, 'launches.jsonl');
const replies = JSON.parse(fs.readFileSync(path.join(__dirname, 'replies.json'), 'utf8'));
const index = fs.readFileSync(log, 'utf8').split('\n').length - 1;
const stdin = fs.readFileSync(0);
fs.appendFileSync(log, JSON.stringify({
  argv: process.argv.slice(2),
  pid: process.pid,
  ppid: process.ppid,
  home: process.env.HOME,
  agentSocket: process.env.SSH_AUTH_SOCK,
  stdinSha256: crypto.createHash('sha256').update(stdin).digest('hex'),
}) + '\n');
const reply = replies[index];
if (!reply) process.exit(97);
if (reply.stdout) fs.writeFileSync(1, reply.stdout);
if (reply.stderr) fs.writeFileSync(2, reply.stderr);
process.exit(reply.code ?? 0);
`;

interface Launch {
  readonly argv: string[];
  readonly pid: number;
  readonly ppid: number;
  readonly home: string;
  readonly agentSocket: string;
  readonly stdinSha256: string;
}

describe.skipIf(process.platform === "win32")("F08 legacy deployment SSH launches", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function setup(options: { approved?: boolean; changedKey?: boolean } = {}) {
    const fixture = await makeDeploymentFixture();
    cleanups.push(fixture.cleanup);
    const graph = await fixture.graph("1.0.0", { url: "none" });
    const archive = await graph.materializeArchive(new AbortController().signal);
    const root = await fs.mkdtemp(join(tmpdir(), "bb-deploy-ssh-"));
    cleanups.push(() => fs.rm(root, { force: true, recursive: true }));
    const home = join(root, "home");
    const agentSocket = join(root, "synthetic-agent.sock");
    const bin = join(root, "bin");
    const log = join(bin, "launches.jsonl");
    await fs.mkdir(home, { mode: 0o700 });
    await fs.mkdir(bin, { mode: 0o700 });
    await fs.writeFile(log, "");
    const inputPath = (name: string) => `${remoteHome}/.bigbud/backend-setup/${REQUEST}/${name}`;
    await fs.writeFile(
      join(bin, "replies.json"),
      JSON.stringify([
        options.changedKey
          ? { code: 255, stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n" }
          : { code: 255, stderr: "Permission denied (publickey).\n" },
        { stdout: `home=${remoteHome}\narch=aarch64\nhost=${"a".repeat(64)}\n` },
        { stdout: "staged\n" },
        {}, // signed graph manifest on stdin
        {}, // binary archive on stdin
        {}, // commit
        { stdout: `path=${inputPath("rust-manifest.json")}\n` },
        { stdout: `path=${inputPath("trusted-keys.json")}\n` },
        { stdout: `Configured authority: ${AUTHORITY}\n` },
        {}, // start
        {
          stdout: JSON.stringify({
            requestId: REQUEST,
            authority,
            installationFingerprint: INSTALLATION,
          }),
        },
      ]),
    );
    await fs.writeFile(join(bin, "recorder.cjs"), recorder);
    await fs.writeFile(
      join(bin, "ssh"),
      '#!/bin/sh\nexec "$BB_DEPLOY_RECORDER_NODE" "${0%/*}/recorder.cjs" "$@"\n',
      { mode: 0o700 },
    );
    const archiveDigest = sha256(await fs.readFile(archive.path));
    await archive.release();
    // No system ssh or credential helpers can be resolved; the agent path is not a socket.
    vi.stubEnv("PATH", bin);
    vi.stubEnv("HOME", home);
    vi.stubEnv("TMPDIR", root);
    vi.stubEnv("SSH_AUTH_SOCK", agentSocket);
    vi.stubEnv("SSH_ASKPASS", undefined);
    vi.stubEnv("SSH_ASKPASS_REQUIRE", undefined);
    vi.stubEnv("BB_DEPLOY_RECORDER_NODE", process.execPath);

    const store = memoryProfileStore();
    const deployment = makeRemoteBackendDeployment({
      approval: makeDeploymentApproval({
        listSavedTargets: async () =>
          options.approved === false
            ? []
            : [{ executionTargetId: input.executionTargetId, deleted: false }],
        evidence: async () => ({ approved: false, unreadable: false }),
      }),
      assertHostTrusted: inspectSshHostTrust,
      run: runDeploymentSsh,
      resolveSource: async () => graph,
      store,
    });
    cleanups.push(deployment.dispose);
    const call = (mode: "desktop" | "remote", authToken: string | undefined) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const handlers = yield* makeWsRpcRemoteBackendDeploymentHandlers();
          return yield* Effect.result(handlers[WS_METHODS.serverSetupRemoteBackend](input));
        }).pipe(
          Effect.provideService(ServerConfig, { mode, authToken } as unknown as ServerConfigShape),
          Effect.provideService(RemoteBackendDeployment, deployment),
        ),
      );
    const launches = async () =>
      (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Launch);
    return { call, launches, store, home, agentSocket, graph, archiveDigest };
  }

  it("launches one trust probe then the ordered deployment commands, streaming the pinned graph on stdin", async () => {
    const f = await setup();
    expect(await f.call("desktop", "synthetic-token")).toMatchObject({
      _tag: "Success",
      success: { profileId: `rb-${AUTHORITY}`, authority, status: "started" },
    });
    const launches = await f.launches();
    expect(launches).toHaveLength(11);
    for (const launch of launches) {
      expect(launch).toMatchObject({ ppid: process.pid, home: f.home, agentSocket: f.agentSocket });
      expect(launch.pid).toBeGreaterThan(0);
      expect(launch.argv.slice(-3, -1)).toEqual(["--", "fixture@127.0.0.1"]);
    }
    const [trust, ...commands] = launches;
    expect(trust!.argv).toEqual(
      expect.arrayContaining([
        "StrictHostKeyChecking=ask",
        "ControlPath=none",
        "PreferredAuthentications=none",
        "PasswordAuthentication=no",
        "PubkeyAuthentication=no",
      ]),
    );
    expect(trust!.argv.at(-1)).toBe("true");
    for (const { argv } of commands) {
      expect(argv.slice(0, -1)).toEqual([
        "-T",
        "-o",
        "BatchMode=yes",
        "-p",
        "2222",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "--",
        "fixture@127.0.0.1",
      ]);
      expect(argv.at(-1)).toMatch(
        /^'\/usr\/bin\/env' '-i' 'PATH=\/usr\/bin:\/bin' 'LC_ALL=C' '\/bin\/sh' '-c' /,
      );
    }
    expect(commands.map(({ argv }) => argv.at(-1))).toEqual([
      expect.stringContaining(`'sh' '${REQUEST}' '/etc/ssh'`),
      expect.stringContaining(`'begin' '${REQUEST}'`),
      expect.stringContaining(`'put' '${REQUEST}' 'manifest.json' '${f.graph.manifestSha256}'`),
      expect.stringContaining(`'fetch-stdin' '${REQUEST}' '${f.graph.archiveSha256}'`),
      expect.stringContaining(`'commit' '${REQUEST}'`),
      expect.stringContaining(`'put-input' '${REQUEST}' 'rust-manifest.json'`),
      expect.stringContaining(`'put-input' '${REQUEST}' 'trusted-keys.json'`),
      expect.stringContaining(`'backend' 'setup'`),
      expect.stringContaining(`'backend' 'start' '--authority' '${AUTHORITY}'`),
      expect.stringContaining(`'sh' '${AUTHORITY}'`),
    ]);
    expect(commands[7]!.argv.at(-1)).toContain(`'HOME=${remoteHome}'`);
    expect(launches.map(({ stdinSha256 }) => stdinSha256)).toEqual([
      sha256(""),
      sha256(""),
      sha256(""),
      f.graph.manifestSha256,
      f.archiveDigest,
      sha256(""),
      sha256(f.graph.rustManifestJson),
      sha256(JSON.stringify(f.graph.trustedKeys)),
      sha256(""),
      sha256(""),
      sha256(""),
    ]);
    expect(f.store.rows).toHaveLength(1);
    expect(await f.call("desktop", "synthetic-token")).toMatchObject({ _tag: "Success" });
    expect(await f.launches()).toEqual(launches);
  });

  it("does not spawn from the remote role or a local backend without configured auth", async () => {
    const f = await setup();
    for (const result of [
      await f.call("remote", "synthetic-token"),
      await f.call("desktop", undefined),
    ]) {
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          code: "unavailable",
          message: "Remote backend deployment requires the authenticated local backend.",
        },
      });
    }
    expect(await f.launches()).toEqual([]);
    expect(f.store.rows).toEqual([]);
  });

  it("refuses unapproved targets before the trust probe or any deployment launch", async () => {
    const f = await setup({ approved: false });
    expect(await f.call("desktop", "synthetic-token")).toMatchObject({
      _tag: "Failure",
      failure: { code: "approval-required" },
    });
    expect(await f.launches()).toEqual([]);
    expect(f.store.rows).toEqual([]);
  });

  it("stops after the trust probe reports a changed host key", async () => {
    const f = await setup({ changedKey: true });
    expect(await f.call("desktop", "synthetic-token")).toMatchObject({
      _tag: "Failure",
      failure: { code: "unavailable", message: "The SSH host identity could not be verified." },
    });
    const launches = await f.launches();
    expect(launches).toHaveLength(1);
    expect(launches[0]!.argv).toContain("PreferredAuthentications=none");
    expect(launches[0]!.argv.at(-1)).toBe("true");
    expect(f.store.rows).toEqual([]);
  });
});

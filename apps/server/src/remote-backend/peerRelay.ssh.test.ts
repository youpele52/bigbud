import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureCoordinatorPeerKey } from "../peer-orchestration/peerSshKey.ts";
import {
  mergePeerAuthorizedKeys,
  peerAuthorizedKeysLine,
  updateAuthorizedKeys,
} from "./peerAuthorizedKeys.ts";
import {
  makePeerRelaySshChannels,
  peerRelaySshArgs,
  type PeerRelaySshTarget,
} from "./peerRelay.ssh.ts";

const WORKER = "c".repeat(32);
const COORDINATOR = "a".repeat(32);
const GRANT = "00000001-0000-4000-8000-000000000001";
const SSHD = "/usr/sbin/sshd";

let dir = "";
let sshd: ChildProcess | undefined;
let port = 0;
let ready = false;
let coordinatorKey = { keyFile: "", fingerprint: "" };
const hostKey = { real: "", other: "" };

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: chosen } = server.address() as net.AddressInfo;
      server.close(() => resolve(chosen));
    });
  });
const listening = (candidate: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(candidate, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
const keygen = (path: string) => {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]);
  return execFileSync("cut", ["-d", " ", "-f", "1,2", `${path}.pub`])
    .toString()
    .trim();
};

beforeAll(async () => {
  if (!existsSync(SSHD) || process.platform === "win32") return;
  dir = await mkdtemp(join(tmpdir(), "peer-ssh-"));
  hostKey.real = keygen(join(dir, "host_key"));
  hostKey.other = keygen(join(dir, "other_host_key"));
  const generated = await ensureCoordinatorPeerKey(join(dir, "coordinator"));
  coordinatorKey = { keyFile: generated.keyFile, fingerprint: generated.publicKey.fingerprint };
  keygen(join(dir, "stranger"));
  // Stands in for the peer relay helper: records its fixed argv, then echoes the channel.
  const helper = join(dir, "helper.mjs");
  await writeFile(
    helper,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(join(dir, "reached.json"))}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.stdin.pipe(process.stdout);\n`,
  );
  const line = peerAuthorizedKeysLine({
    nodeBinary: process.execPath,
    helperEntry: helper,
    workerAuthorityId: WORKER,
    grantId: GRANT,
    coordinatorAuthorityId: COORDINATOR,
    publicKey: await readFile(`${generated.keyFile}.pub`, "utf8"),
  });
  await updateAuthorizedKeys(join(dir, "ssh", "authorized_keys"), (existing) =>
    mergePeerAuthorizedKeys(existing, line),
  );
  port = await freePort();
  await writeFile(
    join(dir, "sshd_config"),
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${join(dir, "host_key")}`,
      `AuthorizedKeysFile ${join(dir, "ssh", "authorized_keys")}`,
      "PidFile none",
      "UsePAM no",
      "StrictModes no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
    ].join("\n"),
  );
  sshd = spawn(SSHD, ["-f", join(dir, "sshd_config"), "-D", "-e"], { stdio: "ignore" });
  for (let attempt = 0; attempt < 40 && !ready; attempt++) {
    ready = await listening(port);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  sshd?.kill("SIGTERM");
  if (dir) await rm(dir, { recursive: true, force: true });
});

const target = (overrides: Partial<PeerRelaySshTarget> = {}): PeerRelaySshTarget => ({
  host: "127.0.0.1",
  port,
  user: userInfo().username,
  workerAuthorityId: WORKER,
  pinnedHostKey: hostKey.real,
  identityFile: coordinatorKey.keyFile,
  ...overrides,
});
const open = (overrides: Partial<PeerRelaySshTarget> = {}) =>
  makePeerRelaySshChannels({
    target: target(overrides),
    knownHostsDirectory: join(dir, "known"),
    configFile: "/dev/null",
  });
const firstChunk = (stream: NodeJS.ReadableStream) =>
  new Promise<string | null>((resolve) => {
    stream.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    stream.once("close", () => resolve(null));
    stream.once("error", () => resolve(null));
  });

describe("peer SSH transport against a local sshd", () => {
  it("reaches only the forced command, with the grant's fixed identity", async (context) => {
    if (!ready) return context.skip();
    await rm(join(dir, "reached.json"), { force: true });
    const owner = open();
    const channel = await owner.openChannel(new AbortController().signal);
    const echoed = firstChunk(channel.stream);
    channel.stream.write("ping\n");
    expect(await echoed).toBe("ping\n");
    // The coordinator's own command ("bigbud-peer") is ignored; argv is the grant's line.
    expect(JSON.parse(await readFile(join(dir, "reached.json"), "utf8"))).toEqual([
      WORKER,
      GRANT,
      COORDINATOR,
      coordinatorKey.fingerprint,
    ]);
    channel.stream.end();
    await owner.dispose();
  });

  it("host_identity_pin_mismatch_refused", async (context) => {
    if (!ready) return context.skip();
    await rm(join(dir, "reached.json"), { force: true });
    const owner = open({ pinnedHostKey: hostKey.other });
    const channel = await owner.openChannel(new AbortController().signal);
    const data = firstChunk(channel.stream);
    channel.stream.write("ping\n");
    expect(await channel.outcome).toBe("host-identity-mismatch");
    expect(await data).toBeNull();
    expect(existsSync(join(dir, "reached.json"))).toBe(false);
    await owner.dispose();
    // An unauthorized key is refused by sshd and never reaches the helper either.
    const stranger = open({ identityFile: join(dir, "stranger") });
    const refused = await stranger.openChannel(new AbortController().signal);
    expect(await refused.outcome).toBe("authentication-refused");
    expect(existsSync(join(dir, "reached.json"))).toBe(false);
    await stranger.dispose();
  });

  it("builds an explicit, agent-free, strictly pinned ssh argv", () => {
    const args = peerRelaySshArgs(
      { ...target(), port: 2222, identityFile: "/k/peer_ed25519" },
      "/k/known",
    );
    for (const option of [
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "UserKnownHostsFile=/k/known",
      "GlobalKnownHostsFile=/dev/null",
      `HostKeyAlias=bigbud-peer-${WORKER}`,
      "UpdateHostKeys=no",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
    ])
      expect(args).toContain(option);
    expect(args.slice(-3)).toEqual(["--", "127.0.0.1", "bigbud-peer"]);
    for (const bad of [
      { host: "-oProxyCommand=x" },
      { user: "root;x" },
      { identityFile: "/k/a b" },
      { port: 0 },
    ])
      expect(() => peerRelaySshArgs({ ...target(), ...bad }, "/k/known")).toThrow();
  });
});

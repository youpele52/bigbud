import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import {
  canonicalBackendGraphPayload,
  decodeBackendGraphManifest,
} from "./backendGraph.manifest.ts";
import {
  makeOwnedClientRelaySshChannels,
  type ClientRelayDeployment,
} from "./clientRelay.ssh.owner.ts";
import type { DeploymentStepOperands } from "../ssh/sshOwnerPickerProof.codec.backend.ts";
import { makeProductionClientRelayOwner } from "./clientRelay.ssh.owner.production.ts";
import { resolvedRelayProfile } from "./deployment.profiles.store.ts";
import {
  makeProductionDeploymentHostTrust,
  makeProductionDeploymentRunner,
} from "./deployment.ssh.owner.production.ts";
import { memoryProfileStore } from "./deployment.test.helpers.ts";
import { makeRemoteBackendDeployment } from "./deployment.ts";

// W2 T-backend live run: a real production owner (target/debug/bigbud-ssh-owner) against a
// disposable non-root sshd, e.g. the OrbStack Debian guest. `remoteBinary` is unused.
// BIGBUD_TEST_TBACKEND_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":"/tmp","remoteBinary":"/unused"}'
// BIGBUD_TEST_TBACKEND_NODE=<local copy of the target's Linux node ELF>
// BIGBUD_TEST_TBACKEND_RELAY_DIR=<remote 0700 dir holding that node as `node` and HELPER below
//   as `remoteBackendClientRelay.mjs`>
// BIGBUD_TEST_TBACKEND_DEPLOY=1 also runs a full deployment; it writes ~/.bigbud/backend-* on
// the target account, so only use a disposable account with a writable home.
const external = readExternalV2Target(process.env.BIGBUD_TEST_TBACKEND_EXTERNAL_TARGET);
const nodeElf = process.env.BIGBUD_TEST_TBACKEND_NODE ?? "";
const relayDir = process.env.BIGBUD_TEST_TBACKEND_RELAY_DIR ?? "";
const deploy = process.env.BIGBUD_TEST_TBACKEND_DEPLOY === "1";
const REQUEST = "5eb1c0de-1111-4222-8333-444455556666";
const AUTHORITY = "fedcba9876543210fedcba9876543210";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** The fake backend CLI: records setup/start and writes the setup completion record. */
const ENTRY = `import fs from "node:fs";
const [, , backend, op, ...rest] = process.argv;
if (backend !== "backend") process.exit(2);
const home = process.env.HOME;
const log = (line) => fs.appendFileSync(home + "/.bigbud/tbackend-live.log", line + "\\n");
if (op === "setup") {
  const request = rest[rest.indexOf("--request-id") + 1];
  const dir = home + "/.bigbud/backend-services/${AUTHORITY}";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + "/setup-complete-v1", JSON.stringify({ requestId: request,
    authority: { authorityId: "${AUTHORITY}", keyEpoch: 1, keyFingerprint: "sha256:${"b".repeat(64)}" },
    installationFingerprint: "sha256:${"c".repeat(64)}" }));
  log("setup " + request + " " + process.env.LANG);
  console.log("Configured authority: ${AUTHORITY}");
} else { log(op + " " + rest.join(" ")); console.log("backend: active"); }
`;
/** The relay helper: echo every byte only after end-of-input, then the authority. */
const HELPER = `const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => process.stdout.end(Buffer.concat([...chunks, Buffer.from(":eof:" + process.argv[2])])));
`;

async function liveGraph(root: string) {
  const tree = join(root, "graph");
  const members = [
    ["runtime/node", await fs.readFile(nodeElf), true],
    ["server/bin.mjs", Buffer.from(ENTRY), false],
    ["server/remote-client-relay/remoteBackendClientRelay.mjs", Buffer.from(HELPER), false],
  ] as const;
  for (const [path, body, executable] of members) {
    await fs.mkdir(join(tree, path, ".."), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(tree, path), body, { mode: executable ? 0o700 : 0o600 });
  }
  const archive = join(root, "graph.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", tree, "runtime", "server"], {
    env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
  });
  const unsigned = {
    revision: 1 as const,
    version: "9.9.9",
    buildDigest: "a".repeat(64),
    target: "aarch64-unknown-linux-gnu" as const,
    node: "runtime/node",
    entry: "server/bin.mjs",
    files: members.map(([path, body, executable]) => ({
      path,
      sizeBytes: body.length,
      sha256: sha(body),
      executable,
    })),
  };
  const keys = generateKeyPairSync("ed25519");
  const signature = { algorithm: "ed25519" as const, keyId: "live", value: "" };
  const payload = canonicalBackendGraphPayload({
    ...unsigned,
    files: unsigned.files.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    signature,
  });
  const raw = {
    ...unsigned,
    signature: { ...signature, value: sign(null, payload, keys.privateKey).toString("base64") },
  };
  const manifestJson = JSON.stringify(raw);
  return {
    origin: "local" as const,
    manifest: decodeBackendGraphManifest(raw),
    manifestJson,
    manifestSha256: sha(manifestJson),
    archiveSha256: sha(await fs.readFile(archive)),
    // Unreachable on purpose: the remote fetch fails (75) and the upload path runs.
    archiveUrl: "https://unreachable.invalid/graph.tar.gz",
    materializeArchive: async () => ({ path: archive, release: async () => {} }),
    trustedKeys: { live: "unused" },
    rustManifestJson: '{"live":true}\n',
  };
}

type Bound = ReturnType<SshOwnerProductionRegistration["handle"]["target"]>;

async function settle(bound: Bound, lease: Uint8Array, step: DeploymentStepOperands) {
  let state = await bound.openDeploymentStep(lease, step);
  while (state.phase === "running") {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await bound.deploymentStepStatus(lease);
  }
  console.log("tbackend-live step", JSON.stringify({ ...state, lease: undefined }));
  return state;
}

/** Four parallel 512 KiB half-closed channels, then a tampered pin that must not run. */
async function relayLoad(
  live: { owner: () => SshOwnerProductionRegistration },
  targetId: string,
  binding: ClientRelayDeployment,
) {
  const relay = makeOwnedClientRelaySshChannels(
    { executionTargetId: targetId, deployment: binding },
    makeProductionClientRelayOwner(live),
  );
  const payload = Buffer.alloc(512 * 1024, 5);
  const started = Date.now();
  const echoed = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const channel = await relay.openChannel(new AbortController().signal);
      const chunks: Buffer[] = [];
      channel.on("data", (chunk: Buffer) => chunks.push(chunk));
      channel.end(payload);
      await once(channel, "end");
      return Buffer.concat(chunks);
    }),
  );
  console.log(`tbackend-live relay 4x512KiB ms=${Date.now() - started}`);
  for (const bytes of echoed) {
    expect(bytes.length).toBe(payload.length + 5 + binding.authorityId.length);
    expect(bytes.subarray(payload.length).toString()).toBe(`:eof:${binding.authorityId}`);
  }
  await relay.dispose();
  const tampered = makeOwnedClientRelaySshChannels(
    { executionTargetId: targetId, deployment: { ...binding, helperSha256: "e".repeat(64) } },
    makeProductionClientRelayOwner(live),
  );
  const refused = await tampered.openChannel(new AbortController().signal);
  refused.resume();
  refused.end();
  await once(refused, "close");
  await expect(tampered.dispose()).rejects.toThrow();
}

it.skipIf(external === undefined || nodeElf === "" || relayDir === "")(
  "runs typed deployment steps and relay channels through the production owner",
  async () => {
    await withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
      const { descriptor } = targets[0]!;
      const bound = handle.target(descriptor);
      const trust = await bound.inspectTrust();
      if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
      const registration = {
        handle,
        descriptorFor: async () => descriptor,
      } as unknown as SshOwnerProductionRegistration;
      const live = { owner: () => registration };
      await makeProductionDeploymentHostTrust(live)(descriptor.targetId);
      // Read-only probe: home, architecture and the host key identity.
      const probe = await settle(bound, new Uint8Array(32).fill(1), {
        kind: "probeHost",
        requestId: REQUEST,
      });
      expect(probe).toMatchObject({ phase: "exited", exitCode: 0 });
      expect(probe.phase === "exited" && probe.stdout).toMatch(
        /^home=\/.+\narch=aarch64\nhost=[a-f0-9]{64}\n(completed=[0-9a-f]{32}\n)?$/,
      );
      // A repeat run on the same account sees the earlier deployment's completion record.
      const completed =
        probe.phase === "exited" && probe.stdout.includes(`completed=${AUTHORITY}\n`);
      // Reset touches only this request's staging directory.
      expect(
        await settle(bound, new Uint8Array(32).fill(2), { kind: "reset", requestId: REQUEST }),
      ).toMatchObject({ phase: "exited", exitCode: 0, stdout: "reset\n" });
      // A missing completion record is an ordinary nonzero exit, not an unknown outcome;
      // an existing one (repeat run) reads back with exit 0.
      const record = await settle(bound, new Uint8Array(32).fill(3), {
        kind: "readCompletion",
        authorityId: AUTHORITY,
      });
      expect(record.phase).toBe("exited");
      if (completed) expect(record.phase === "exited" && record.exitCode).toBe(0);
      else expect(record.phase === "exited" && record.exitCode).not.toBe(0);
      // Cancel: a streamed step whose socket is never dialled settles cancelled, and the
      // same token reattaches to that outcome instead of running anything again.
      const lease = new Uint8Array(32).fill(7);
      expect(
        (
          await bound.openDeploymentStep(lease, {
            kind: "archiveUpload",
            requestId: REQUEST,
            inputSha256: "d".repeat(64),
            maxBytes: 10,
          })
        ).phase,
      ).toBe("listening");
      expect((await bound.cancelDeploymentStep(lease)).phase).toBe("cancelled");
      expect((await bound.openDeploymentStep(lease, { kind: "reset" })).phase).toBe("cancelled");
      await expect(
        bound.openDeploymentStep(new Uint8Array(32).fill(8), { kind: "setup" }),
      ).rejects.toMatchObject({ code: "invalidOperands" });
      await relayLoad(live, descriptor.targetId, {
        nodeBinary: `${relayDir}/node`,
        nodeSha256: sha(await fs.readFile(nodeElf)),
        helperEntry: `${relayDir}/remoteBackendClientRelay.mjs`,
        helperSha256: sha(HELPER),
        authorityId: AUTHORITY,
      });
    });
  },
  300_000,
);

it.skipIf(external === undefined || nodeElf === "" || !deploy)(
  "deploys a backend graph end to end and relays through its stored profile",
  async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "bb-tbe-"));
    try {
      const graph = await liveGraph(root);
      await withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
        const { descriptor } = targets[0]!;
        const bound = handle.target(descriptor);
        const trust = await bound.inspectTrust();
        if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
        const registration = {
          handle,
          descriptorFor: async () => descriptor,
        } as unknown as SshOwnerProductionRegistration;
        const live = { owner: () => registration };
        const store = memoryProfileStore();
        const deployment = makeRemoteBackendDeployment({
          approval: async () => ({ approved: true }),
          assertHostTrusted: makeProductionDeploymentHostTrust(live),
          run: makeProductionDeploymentRunner(live),
          resolveSource: async () => graph,
          store,
        });
        const started = Date.now();
        const result = await deployment.setupRemoteBackend(
          { executionTargetId: descriptor.targetId, requestId: REQUEST, enableBoot: false },
          new AbortController().signal,
        );
        console.log(`tbackend-live deploy ms=${Date.now() - started}`);
        expect(result).toMatchObject({ profileId: `rb-${AUTHORITY}`, status: "started" });
        await relayLoad(live, descriptor.targetId, resolvedRelayProfile(store.rows[0]!).deployment);
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  600_000,
);

import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  makeRemoteBackendDeployment,
  type RemoteBackendDeploymentDependencies,
} from "./deployment.ts";
import { stageRemoteBackendGraph } from "./deployment.fetch.ts";
import { resolvedRelayProfile } from "./deployment.profiles.store.ts";
import {
  AUTHORITY,
  INSTALLATION,
  KEY_FINGERPRINT,
  makeDeploymentFixture,
  memoryProfileStore,
  REQUEST,
  TARGET,
  type DeploymentFixture,
} from "./deployment.test.helpers.ts";
import type { DeploymentGraphSource } from "./deployment.types.ts";

const fixtures: DeploymentFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
async function setup(
  source: (fixture: DeploymentFixture) => Promise<DeploymentGraphSource>,
  overrides: Partial<RemoteBackendDeploymentDependencies> = {},
) {
  const fixture = await makeDeploymentFixture();
  fixtures.push(fixture);
  const store = memoryProfileStore();
  const graph = await source(fixture);
  const deployment = makeRemoteBackendDeployment({
    approval: async () => ({ approved: true }),
    assertHostTrusted: async () => {},
    run: fixture.run,
    resolveSource: async () => graph,
    store,
    now: () => "2026-11-17T00:00:00.000Z",
    ...overrides,
  });
  return { fixture, store, graph, deployment };
}
const input = (enableBoot = false) => ({
  executionTargetId: TARGET,
  requestId: REQUEST,
  enableBoot,
});
const never = new AbortController().signal;

it("deployment_refuses_unapproved_host", async () => {
  const { fixture, store, deployment } = await setup((f) => f.graph("1.0.0"), {
    approval: async () => ({ approved: false }),
  });
  await expect(deployment.setupRemoteBackend(input(), never)).rejects.toMatchObject({
    code: "approval-required",
  });
  expect(fixture.calls).toEqual([]);
  expect(store.rows).toEqual([]);
});

it("profile_pins_authority_and_installation", async () => {
  const { fixture, store, graph, deployment } = await setup((f) => f.graph("1.0.0"));
  const result = await deployment.setupRemoteBackend(input(), never);
  expect(result).toEqual({
    profileId: `rb-${AUTHORITY}`,
    authority: { authorityId: AUTHORITY, keyFingerprint: KEY_FINGERPRINT, keyEpoch: 1 },
    status: "started",
  });
  const [record] = store.rows;
  const graphRoot = `${fixture.home}/.bigbud/backend-graphs/1.0.0-aarch64-unknown-linux-gnu-${graph.archiveSha256.slice(0, 16)}/graph`;
  const pin = (path: string) => graph.manifest.files.find((file) => file.path === path)!.sha256;
  expect(record).toMatchObject({
    authorityId: AUTHORITY,
    keyFingerprint: KEY_FINGERPRINT,
    installationFingerprint: INSTALLATION,
    hostIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    graphVersion: "1.0.0",
    graphArchiveSha256: graph.archiveSha256,
    graphRoot,
    nodeBinary: `${graphRoot}/runtime/node`,
    nodeSha256: pin("runtime/node"),
    helperEntry: `${graphRoot}/server/remote-client-relay/remoteBackendClientRelay.mjs`,
    helperSha256: pin("server/remote-client-relay/remoteBackendClientRelay.mjs"),
    bootEnabled: false,
  });
  expect(resolvedRelayProfile(record!).deployment).toEqual({
    nodeBinary: record!.nodeBinary,
    nodeSha256: record!.nodeSha256,
    helperEntry: record!.helperEntry,
    helperSha256: record!.helperSha256,
    authorityId: AUTHORITY,
  });
  // D8: without boot consent the backend is started, never enabled.
  expect(await fixture.backendLog()).toEqual([
    `setup ${REQUEST}`,
    `start --authority ${AUTHORITY}`,
  ]);
  expect(await fs.readFile(record!.helperEntry, "utf8")).toBe("// relay 1.0.0\n");
});

it("enables boot startup only with explicit consent", async () => {
  const { fixture, deployment } = await setup((f) => f.graph("1.0.0"));
  expect((await deployment.setupRemoteBackend(input(true), never)).status).toBe("enabled");
  expect((await fixture.backendLog())[1]).toBe(`enable --authority ${AUTHORITY} --confirm-startup`);
});

it("repeat_request_is_idempotent", async () => {
  const { fixture, store, deployment } = await setup((f) => f.graph("1.0.0"));
  const [first, joined] = await Promise.all([
    deployment.setupRemoteBackend(input(), never),
    deployment.setupRemoteBackend(input(), never),
  ]);
  const replay = await deployment.setupRemoteBackend(input(), never);
  expect(joined).toEqual(first);
  expect(replay).toEqual(first);
  expect(store.rows).toHaveLength(1);
  expect((await fixture.backendLog()).filter((line) => line.startsWith("setup"))).toHaveLength(1);
  await expect(deployment.setupRemoteBackend(input(true), never)).rejects.toMatchObject({
    code: "conflict",
  });
});

it("recovers a finished remote setup without running setup twice", async () => {
  let failures = 1;
  const store = memoryProfileStore();
  const { fixture, deployment } = await setup((f) => f.graph("1.0.0"), {
    store: {
      ...store,
      insert: async (record) => {
        if (failures-- > 0) throw new Error("lost local write");
        return store.insert(record);
      },
    },
  });
  await expect(deployment.setupRemoteBackend(input(), never)).rejects.toMatchObject({
    code: "unavailable",
  });
  expect((await deployment.setupRemoteBackend(input(), never)).profileId).toBe(`rb-${AUTHORITY}`);
  const log = await fixture.backendLog();
  expect(log.filter((line) => line.startsWith("setup"))).toHaveLength(1);
  expect(log.filter((line) => line.startsWith("start"))).toHaveLength(2);
});

it("download_hash_mismatch_preserves_previous", async () => {
  const fixture = await makeDeploymentFixture();
  fixtures.push(fixture);
  const previous = await fixture.graph("1.0.0");
  const staged = await stageRemoteBackendGraph({
    executionTargetId: TARGET,
    requestId: "22222222-2222-4333-8444-555555555555",
    remoteHome: fixture.home,
    source: previous,
    run: fixture.run,
    signal: never,
  });
  const before = await fs.readFile(join(staged.graphRoot, "runtime/node"), "utf8");
  const tampered = await fixture.graph("2.0.0", { pin: "d".repeat(64) });
  const store = memoryProfileStore();
  const deployment = makeRemoteBackendDeployment({
    approval: async () => ({ approved: true }),
    assertHostTrusted: async () => {},
    run: fixture.run,
    resolveSource: async () => tampered,
    store,
  });
  await expect(deployment.setupRemoteBackend(input(), never)).rejects.toMatchObject({
    code: "hash-mismatch",
  });
  const base = join(fixture.home, ".bigbud/backend-graphs");
  expect(await fs.readdir(base)).toEqual([staged.installDir.split("/").at(-1)]);
  expect(await fs.readFile(join(staged.graphRoot, "runtime/node"), "utf8")).toBe(before);
  expect(await fs.readFile(join(staged.installDir, "complete"), "utf8")).toBe(
    `${previous.archiveSha256} ${previous.manifestSha256}\n`,
  );
  expect(store.rows).toEqual([]);
  expect(await fixture.backendLog()).toEqual([]);
});

it("falls back to uploading from this device when the VPS download fails", async () => {
  const { fixture, store, deployment } = await setup((f) =>
    f.graph("1.0.0", { url: "unreachable" }),
  );
  await deployment.setupRemoteBackend(input(), never);
  const stages = fixture.calls.map((call) => call.args[3]).filter(Boolean);
  expect(stages).toContain("fetch-url");
  expect(fixture.calls.find((call) => call.args[3] === "fetch-stdin")?.stdin).toMatchObject({
    path: expect.stringMatching(/graph-1\.0\.0\.tar\.gz$/),
  });
  expect(store.rows).toHaveLength(1);
});

it("refuses a host whose identity changed since its profile", async () => {
  const { store, deployment } = await setup((f) => f.graph("1.0.0"));
  await deployment.setupRemoteBackend(input(), never);
  store.rows[0] = { ...store.rows[0]!, hostIdentity: `sha256:${"e".repeat(64)}` };
  await expect(
    deployment.setupRemoteBackend(
      { ...input(), requestId: "33333333-2222-4333-8444-555555555555" },
      never,
    ),
  ).rejects.toMatchObject({ code: "host-changed" });
});

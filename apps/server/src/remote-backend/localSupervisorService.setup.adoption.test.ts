import "./localSupervisorService.setup.test.portability.ts";
import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { parseSetupRefusalCode } from "./localSupervisorService.setup.adoption.rules.ts";
import { prepareSetupRuntimeState } from "./localSupervisorService.setup.runtime.ts";
import { makeLocalSupervisorServiceSetup } from "./localSupervisorService.setup.ts";
import { setupFixture, type SetupFixture } from "./localSupervisorService.setup.test.helpers.ts";
import {
  adoptingSetup,
  expectUntouched,
  seedManagedAgent,
  stopSupervisor,
  supervisorAlive,
  type ManagedAgentSeed,
} from "./localSupervisorService.setup.adoption.test.helpers.ts";

const fixtures: SetupFixture[] = [];
const seeds: ManagedAgentSeed[] = [];
afterEach(async () => {
  seeds.splice(0).forEach(stopSupervisor);
  await Promise.all(fixtures.splice(0).map((f) => fs.rm(f.root, { recursive: true, force: true })));
});
async function seeded(mutate?: Parameters<typeof seedManagedAgent>[1]) {
  const f = await setupFixture();
  fixtures.push(f);
  const seed = await seedManagedAgent(f, mutate);
  seeds.push(seed);
  return { f, seed };
}
const authorityPath = (seed: ManagedAgentSeed) => join(seed.root, "account-authority-v1");

it("adopts a verified managed install without relaunching its live supervisor or releasing pins", async () => {
  const { f, seed } = await seeded();
  const { setup, seen } = adoptingSetup(f, seed);
  const result = await f.withContext((context, signal) => setup(context, f.input, signal));
  expect(result).toMatchObject({ status: "configured", epoch: "777", runtime: seed.runtime });
  expect(f.events).toEqual(["claim", "install", "admit"]);
  expect(seen.adoption).toMatchObject({ mode: "adopt" });
  expect(seen.adoption?.mode === "adopt" && [...seen.adoption.liveBuildIds]).toEqual([
    seed.buildId,
  ]);
  expect(seen.laptopPinKept).toBe(true);
  // No launch/stop command ran; the live generation, registry pins and process are untouched.
  expect(f.commands.some((c) => /start-rust|--backend-service (?:stop|run)|kill /.test(c))).toBe(
    false,
  );
  await expectUntouched(seed);
  expect((await fs.stat(authorityPath(seed))).mode & 0o777).toBe(0o600);
  // A completed adoption is never re-run; the deployment recovers it from setup-complete-v1.
  await expect(
    f.withContext((context, signal) => setup(context, f.input, signal)),
  ).rejects.toMatchObject({ cause: { phase: "validate", needsRepair: false } });
  expect(f.events).toEqual(["claim", "install", "admit"]);
});

it("re-runs adoption idempotently after an earlier attempt stopped right after its claim", async () => {
  const { f, seed } = await seeded();
  await f.withContext(async (context) => {
    const target = `remote-backend:${context.identity.authority.authorityId}`;
    const control = f.dependencies.control(f.home, target, new AbortController().signal);
    await f.dependencies.claim(control, context.identity, {
      confirmFreshSetup: true,
      backendHome: f.backendHome,
      backendStateDir: context.owner.stateDir,
      adoptExistingState: true,
    });
  });
  const claimed = await fs.readFile(authorityPath(seed), "utf8");
  const { setup } = adoptingSetup(f, seed);
  await expect(
    f.withContext((context, signal) => setup(context, f.input, signal)),
  ).resolves.toMatchObject({ status: "configured" });
  expect(await fs.readFile(authorityPath(seed), "utf8")).toBe(claimed);
  await expectUntouched(seed);
});

const stage = (buildId: string) => ({ id: "laptop-stage", buildId, phase: "reserved" as const });
const refusals: ReadonlyArray<
  [
    string,
    string,
    ((r: RemoteAgentRegistry, id: string) => RemoteAgentRegistry) | undefined,
    ((f: SetupFixture, seed: ManagedAgentSeed) => Promise<void>) | undefined,
  ]
> = [
  ["unknown file", "unknown-state", undefined, (_f, s) => fs.writeFile(join(s.root, "notes"), "x")],
  ["legacy state dir", "legacy-owner", undefined, (_f, s) => fs.mkdir(join(s.root, "state"))],
  [
    "legacy pin",
    "legacy-owner",
    (r, id) => ({ ...r, pins: [...r.pins, { owner: "unknown-legacy-owner", buildId: id }] }),
    undefined,
  ],
  [
    "tampered build bytes",
    "unverifiable-build",
    undefined,
    (_f, s) => fs.writeFile(s.runtime.binaryPath, "tampered\n", { mode: 0o700 }),
  ],
  [
    "unauthenticated build",
    "unverifiable-build",
    (r) => ({ ...r, builds: r.builds.map((b) => ({ ...b, authenticated: false })) }),
    undefined,
  ],
  [
    "mismatched --check identity",
    "unverifiable-build",
    undefined,
    async (f) => {
      f.probes.identity = "bigbud-remote-agent 1-fixture 1 0 other-digest linux aarch64";
    },
  ],
  [
    "concurrent laptop install",
    "install-in-progress",
    (r, id) => ({ ...r, stages: [stage(id)] }),
    undefined,
  ],
  [
    "uncertain update",
    "ambiguous-state",
    (r, id) => ({ ...r, updates: [{ requestId: "laptop-u", buildId: id, phase: "uncertain" }] }),
    undefined,
  ],
  [
    "stopped supervisor",
    "stale-supervisor",
    undefined,
    async (f) => {
      f.probes.observation = "prior-boot-dead";
    },
  ],
  [
    "foreign authority",
    "foreign-owner",
    undefined,
    (_f, s) => fs.writeFile(join(s.root, "account-authority-v1"), "version=1\n", { mode: 0o600 }),
  ],
];
it.each(refusals)(
  "refuses %s with %s before any mutation",
  async (_name, code, mutate, prepare) => {
    const { f, seed } = await seeded(mutate);
    await prepare?.(f, seed);
    const before = (await fs.readdir(seed.root)).toSorted();
    const { setup, seen } = adoptingSetup(f, seed);
    await expect(
      f.withContext((context, signal) => setup(context, f.input, signal)),
    ).rejects.toMatchObject({ cause: { phase: "claim", needsRepair: false, cause: { code } } });
    // The CLI-visible typed line round-trips to the code the laptop deployment maps.
    expect(seen.lines).toHaveLength(1);
    expect(parseSetupRefusalCode(seen.lines[0]!)).toBe(code);
    expect(f.events).toEqual([]);
    expect((await fs.readdir(seed.root)).toSorted()).toEqual(before);
    await expect(fs.lstat(join(f.home, ".bigbud/backend-services"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(seed.registryPath, "utf8")).toBe(seed.registryText);
    expect(supervisorAlive(seed)).toBe(true);
  },
);

it("refuses when a laptop install starts between verification and the ownership claim", async () => {
  const { f, seed } = await seeded();
  const raced = JSON.stringify({
    ...JSON.parse(seed.registryText),
    revision: 8,
    stages: [stage(seed.buildId)],
  });
  const setup = makeLocalSupervisorServiceSetup({
    ...f.dependencies,
    claim: async (...args) => {
      await fs.writeFile(seed.registryPath, raced, { mode: 0o600 });
      return f.dependencies.claim(...args);
    },
  });
  await expect(
    f.withContext((context, signal) => setup(context, f.input, signal)),
  ).rejects.toMatchObject({
    cause: { phase: "claim", needsRepair: true, cause: { code: "install-in-progress" } },
  });
  expect(f.events).toEqual(["claim"]);
  expect(await fs.readFile(seed.registryPath, "utf8")).toBe(raced);
  expect(supervisorAlive(seed)).toBe(true);
});

it("keeps fresh setup on the empty-generation path", async () => {
  const f = await setupFixture();
  fixtures.push(f);
  const modes: unknown[] = [];
  const setup = makeLocalSupervisorServiceSetup({
    ...f.dependencies,
    install: async (control, source, signal, adoption) => {
      modes.push(adoption);
      return f.dependencies.install(control, source, signal, adoption);
    },
  });
  await f.withContext((context, signal) => setup(context, f.input, signal));
  expect(modes).toEqual([{ mode: "fresh" }]);
  expect(f.events).toEqual(["claim", "install", "admit"]);
});

it("never reuses non-empty runtime state unless its supervisor was observed live", async () => {
  const { seed } = await seeded();
  const signal = new AbortController().signal;
  await expect(prepareSetupRuntimeState(seed.runtime, { mode: "fresh" }, signal)).rejects.toThrow(
    /must be empty/,
  );
  const adopt = {
    mode: "adopt" as const,
    names: [],
    registryText: seed.registryText,
    connectionIds: new Set<string>(),
  };
  await expect(
    prepareSetupRuntimeState(seed.runtime, { ...adopt, liveBuildIds: new Set() }, signal),
  ).rejects.toThrow(/must be empty/);
  await expect(
    prepareSetupRuntimeState(
      seed.runtime,
      { ...adopt, liveBuildIds: new Set([seed.buildId]) },
      signal,
    ),
  ).resolves.toBeUndefined();
});

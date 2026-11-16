import "./localSupervisorService.setup.test.portability.ts";
import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { readOwnershipLock } from "@bigbud/shared/backendOwnership.record";
import { decodeLocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";
import { makeLocalSupervisorServiceSetup } from "./localSupervisorService.setup.ts";
import { makeLocalSupervisorServiceSetupInspector } from "./localSupervisorService.setup.status.ts";
import type { LocalSupervisorServiceSetupInput } from "./localSupervisorService.setup.types.ts";
import { setupFixture, type SetupFixture } from "./localSupervisorService.setup.test.helpers.ts";
const fixtures: SetupFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => fs.rm(f.root, { recursive: true, force: true })));
});
async function fixture(graphInsideState = false) {
  const f = await setupFixture(graphInsideState);
  fixtures.push(f);
  return f;
}
it("uses real finite ownership, signed proofs and canonical SQL while staging only the backend unit", async () => {
  const f = await fixture();
  const result = await f.withContext((context, signal) => f.setup(context, f.input, signal));
  expect(result).toMatchObject({
    status: "configured",
    epoch: "123456",
    backendEnabled: false,
    backendStarted: false,
  });
  expect(f.events).toEqual(["claim", "install", "admit"]);
  const config = decodeLocalSupervisorServiceConfig(await fs.readFile(result.configPath, "utf8"));
  expect(config.expected_installation_fingerprint).toBe(result.installationFingerprint);
  for (const name of ["config-v1", "client-token", "artifact-receipt", "setup-complete-v1"]) {
    const stat = await fs.stat(join(join(result.configPath, ".."), name));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
  }
  expect(f.commands.some((c) => c.includes("--backend-service stage"))).toBe(true);
  expect(f.commands.some((c) => /--backend-service (?:enable|run)\b/.test(c))).toBe(false);
  expect(JSON.stringify(result)).not.toContain(
    await fs.readFile(join(result.configPath, "../client-token"), "utf8"),
  );
  await f.withContext(async (context, signal) => {
    const status = await makeLocalSupervisorServiceSetupInspector(f.dependencies)(context, signal);
    expect(status).toMatchObject({
      status: "present",
      backendReadiness: "not-assessed",
      epoch: "123456",
    });
  });
  const before = await fs.readFile(result.configPath, "utf8");
  await expect(
    f.withContext((context, signal) => f.setup(context, f.input, signal)),
  ).rejects.toMatchObject({ cause: { needsRepair: false, phase: "validate" } });
  expect(await fs.readFile(result.configPath, "utf8")).toBe(before);
  expect(f.events).toEqual(["claim", "install", "admit"]);
});
it.each([
  "cloned-proof",
  "changed-graph",
  "unsigned-source",
  "wrong-signature",
  "wrong-state-root",
])("refuses %s before account claim", async (kind) => {
  const f = await fixture();
  let input: LocalSupervisorServiceSetupInput = f.input;
  if (kind === "cloned-proof") input = { ...input, graph: { ...input.graph } };
  if (kind === "changed-graph") await fs.writeFile(join(f.graphRoot, "chunk.mjs"), "changed");
  if (kind === "unsigned-source")
    input = {
      ...input,
      rustSource: { ...input.rustSource, allowUntrustedDevelopmentArtifact: true },
    };
  if (kind === "wrong-signature")
    input = {
      ...input,
      rustSource: {
        ...input.rustSource,
        manifest: {
          ...input.rustSource.manifest,
          artifacts: input.rustSource.manifest.artifacts.map((a) => ({
            ...a,
            signature: { ...a.signature, value: "A".repeat(88) },
          })),
        },
      },
    };
  if (kind === "wrong-state-root") input = { ...input, backendHome: f.home };
  await expect(
    f.withContext((context, signal) => f.setup(context, input, signal)),
  ).rejects.toMatchObject({ cause: { needsRepair: false, phase: "validate" } });
  expect(f.events).toEqual([]);
  await expect(fs.lstat(join(f.home, ".bigbud/agent"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("preserves a durable namespace after staging failure and refuses implicit retry", async () => {
  const f = await fixture();
  const setup = makeLocalSupervisorServiceSetup({
    ...f.dependencies,
    install: async () => {
      throw new Error("stage failed");
    },
  });
  let path = "";
  await expect(
    f.withContext(async (context, signal) => {
      path = join(f.home, ".bigbud/backend-services", context.identity.authority.authorityId);
      return setup(context, f.input, signal);
    }),
  ).rejects.toMatchObject({ cause: { needsRepair: true, phase: "stage-runtime" } });
  expect(await fs.readdir(path)).toEqual([]);
  await expect(
    f.withContext((context, signal) => f.setup(context, f.input, signal)),
  ).rejects.toMatchObject({ cause: { phase: "validate" } });
  await f.withContext(async (context, signal) =>
    expect(
      await makeLocalSupervisorServiceSetupInspector(f.dependencies)(context, signal),
    ).toMatchObject({ status: "needs-repair" }),
  );
});
it("revalidates after staging before any credential/config publication", async () => {
  const f = await fixture();
  let path = "";
  const setup = makeLocalSupervisorServiceSetup({
    ...f.dependencies,
    install: async (...args) => {
      const runtime = await f.dependencies.install(...args);
      await fs.writeFile(join(f.graphRoot, "chunk.mjs"), "changed before publication");
      return runtime;
    },
  });
  await expect(
    f.withContext(async (context, signal) => {
      path = join(f.home, ".bigbud/backend-services", context.identity.authority.authorityId);
      return setup(context, f.input, signal);
    }),
  ).rejects.toMatchObject({ cause: { phase: "publish-config", needsRepair: true } });
  expect(await fs.readdir(path)).toEqual([]);
  expect(f.commands.some((c) => c.includes("--backend-service stage"))).toBe(false);
});
it("holds accepted staging to settlement after cancellation before releasing the real backend lock", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  let lockPath = "",
    settled = false;
  const setup = makeLocalSupervisorServiceSetup({
    ...f.dependencies,
    install: async (...args) => {
      entered();
      await gate;
      return f.dependencies.install(...args);
    },
  });
  const pending = f.withContext(async (context) => {
    lockPath = context.owner.lockPath;
    return setup(context, f.input, controller.signal);
  });
  const outcome = pending.then(
    (value) => ({ ok: true as const, value }),
    (cause) => ({ ok: false as const, cause }),
  );
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.race([
    started,
    outcome.then((result) => {
      if (!result.ok) throw result.cause;
    }),
  ]);
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(await readOwnershipLock(lockPath)).toBeDefined();
  release();
  expect(await outcome).toMatchObject({
    ok: false,
    cause: { cause: { phase: "stage-runtime", needsRepair: true } },
  });
  expect(settled).toBe(true);
  expect(await readOwnershipLock(lockPath)).toBeUndefined();
});

it("refuses preexisting P4 runtime state rather than adopting a standalone supervisor", async () => {
  const f = await fixture();
  await f.withContext(async (context) => {
    const control = f.dependencies.control(
      f.home,
      `remote-backend:${context.identity.authority.authorityId}`,
      new AbortController().signal,
    );
    await f.dependencies.claim(control, context.identity, {
      confirmFreshSetup: true,
      backendHome: f.backendHome,
      backendStateDir: context.owner.stateDir,
    });
    await fs.mkdir(join(control.root, "runtimes"), { mode: 0o700 });
  });
  await expect(
    f.withContext((context, signal) => f.setup(context, f.input, signal)),
  ).rejects.toMatchObject({ cause: { phase: "claim", needsRepair: true } });
  expect(f.events).not.toContain("install");
  expect(f.commands).toEqual([]);
});

it("refuses a valid graph nested inside the actual held backend state before account writes", async () => {
  const f = await fixture(true);
  await expect(
    f.withContext((context, signal) => f.setup(context, f.input, signal)),
  ).rejects.toMatchObject({ cause: { needsRepair: false, phase: "validate" } });
  expect(f.events).toEqual([]);
  await expect(fs.lstat(join(f.home, ".bigbud/agent"))).rejects.toMatchObject({ code: "ENOENT" });
});

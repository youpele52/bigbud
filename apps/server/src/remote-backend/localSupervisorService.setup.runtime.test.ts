import "./localSupervisorService.setup.test.portability.ts";
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { RemoteAgentConnection } from "../remote-agent/remoteAgentConnection.ts";
import { localSupervisorServiceSetupDependencies } from "./localSupervisorService.setup.runtime.ts";
import { makeLocalSupervisorServiceSetup } from "./localSupervisorService.setup.ts";
import { setupFixture, type SetupFixture } from "./localSupervisorService.setup.test.helpers.ts";
import { readOwnershipLock } from "@bigbud/shared/backendOwnership.record";
const state = vi.hoisted(() => ({
  runtime: undefined as RemoteAgentRuntime | undefined,
  connect: undefined as undefined | (() => Promise<RemoteAgentConnection>),
}));
vi.mock("./localSupervisorTransport.ts", async (original) => ({
  ...(await original<typeof import("./localSupervisorTransport.ts")>()),
  connectLocalSupervisorProxy: () => {
    if (!state.connect) throw Error("Fixture connection required.");
    return state.connect();
  },
}));
// P4 wire is controlled here; the original OS proxy and finite lock/SQL lifetime are real.
vi.mock("../remote-agent/remoteAgentUpdate.prepare.ts", async (original) => ({
  ...(await original<typeof import("../remote-agent/remoteAgentUpdate.prepare.ts")>()),
  prepareStagedRemoteAgentCandidate: async (
    input: Parameters<
      typeof import("../remote-agent/remoteAgentUpdate.prepare.ts").prepareStagedRemoteAgentCandidate
    >[0],
  ) => {
    if (!state.runtime || !input.connect) throw Error("Fixture preparation required.");
    const connection = await input.connect(input.target, state.runtime);
    connection.close();
    return "123456";
  },
}));
vi.mock("../remote-agent/remoteAgentAdmission.ts", async (original) => ({
  ...(await original<typeof import("../remote-agent/remoteAgentAdmission.ts")>()),
  makeRemoteAgentAdmission: (
    input: Parameters<
      typeof import("../remote-agent/remoteAgentAdmission.ts").makeRemoteAgentAdmission
    >[0],
  ) => ({
    fresh: async (target: string, id: string) => {
      if (!state.runtime || !input?.bindings) throw Error("Canonical fixture bindings required.");
      await input.bindings.bindConnection(target, id, {
        runtime: state.runtime,
        expectedEpoch: "123456",
      });
    },
  }),
}));
const fixtures: SetupFixture[] = [],
  connections: Array<{
    connection: RemoteAgentConnection;
    close: () => Promise<void>;
    gate: string;
  }> = [];
afterEach(async () => {
  for (const item of connections.splice(0)) {
    await fs.writeFile(item.gate, "exit");
    await item.close();
  }
  await Promise.all(fixtures.splice(0).map((f) => fs.rm(f.root, { recursive: true, force: true })));
  state.runtime = undefined;
  state.connect = undefined;
});
async function observed(path: string) {
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    try {
      await fs.access(path);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  throw Error("Original proxy fixture deadline.");
}
async function fixture(unknownCleanup = false) {
  const f = await setupFixture();
  fixtures.push(f);
  const ready = join(f.root, "ready"),
    term = join(f.root, "term"),
    gate = join(f.root, "exit-gate"),
    exited = join(f.root, "exited");
  state.connect = async () => {
    const script = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(term)},'term');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(exited)},'done');process.exit(0)}},5)});setInterval(()=>{},1000);fs.writeFileSync(${JSON.stringify(ready)},'ready');`;
    const connection = RemoteAgentConnection.local({
      binaryPath: process.execPath,
      args: ["-e", script],
      env: { PATH: "/usr/bin:/bin" },
    });
    const originalClose = connection.closeConfirmed.bind(connection);
    connections.push({ connection, close: originalClose, gate });
    if (unknownCleanup)
      connection.closeConfirmed = async () => {
        throw new Error("fixture unconfirmed original proxy");
      };
    await observed(ready);
    return connection;
  };
  const dependencies = {
    ...f.dependencies,
    install: async (...args: Parameters<typeof f.dependencies.install>) => {
      state.runtime = await f.dependencies.install(...args);
      return state.runtime;
    },
    admit: localSupervisorServiceSetupDependencies.admit,
  };
  return {
    ...f,
    dependencies,
    setup: makeLocalSupervisorServiceSetup(dependencies),
    term,
    gate,
    exited,
  };
}
it("default admission waits original delayed exit after plain close before releasing SQL/lock", async () => {
  const f = await fixture();
  let settled = false,
    lock = "";
  const pending = f.withContext(async (context, signal) => {
    lock = context.owner.lockPath;
    return f.setup(context, f.input, signal);
  });
  const outcome = pending.then(
    (value) => ({ ok: true as const, value }),
    (cause) => ({ ok: false as const, cause }),
  );
  void outcome.then(() => {
    settled = true;
  });
  await Promise.race([
    observed(f.term),
    outcome.then((r) => {
      if (!r.ok) throw r.cause;
    }),
  ]);
  await new Promise((r) => setTimeout(r, 0));
  expect(settled).toBe(false);
  expect(await readOwnershipLock(lock)).toBeDefined();
  await fs.writeFile(f.gate, "exit");
  const result = await outcome;
  expect(result.ok).toBe(true);
  await expect(fs.access(f.exited)).resolves.toBeUndefined();
  expect(await readOwnershipLock(lock)).toBeUndefined();
});
it("abort still joins the original cancelled proxy before finite context release", async () => {
  const f = await fixture(),
    abort = new AbortController();
  let lock = "",
    settled = false;
  const pending = f.withContext(async (context) => {
    lock = context.owner.lockPath;
    return f.setup(context, f.input, abort.signal);
  });
  const outcome = pending.then(
    (value) => ({ ok: true as const, value }),
    (cause) => ({ ok: false as const, cause }),
  );
  void outcome.then(() => {
    settled = true;
  });
  await Promise.race([
    observed(f.term),
    outcome.then((r) => {
      if (!r.ok) throw r.cause;
    }),
  ]);
  abort.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(await readOwnershipLock(lock)).toBeDefined();
  await fs.writeFile(f.gate, "exit");
  expect(await outcome).toMatchObject({
    ok: false,
    cause: { cause: { needsRepair: true, phase: "admit-runtime" } },
  });
  await expect(fs.access(f.exited)).resolves.toBeUndefined();
  expect(await readOwnershipLock(lock)).toBeUndefined();
});

it("unconfirmed proxy cleanup preserves repair state without a completion receipt", async () => {
  const f = await fixture(true);
  let configRoot = "";
  await expect(
    f.withContext((context, signal) => {
      configRoot = join(f.home, ".bigbud/backend-services", context.identity.authority.authorityId);
      return f.setup(context, f.input, signal);
    }),
  ).rejects.toMatchObject({ cause: { phase: "admit-runtime", needsRepair: true } });
  await expect(fs.lstat(join(configRoot, "config-v1"))).resolves.toBeDefined();
  await expect(fs.lstat(join(configRoot, "setup-complete-v1"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

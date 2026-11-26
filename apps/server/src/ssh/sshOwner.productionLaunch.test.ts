import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import type { SshOwnerProductionProfile } from "./sshOwnerProductionClient.launch.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { pickerProofLaunchArgs } from "./sshOwnerPickerProof.client.args.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import {
  killIfAlive,
  makeProductionFixture,
  waitFor,
  waitForDeath,
  type ProductionFixture,
} from "./sshOwnerProductionClient.fixture.ts";

type Sql = SqlClient.SqlClient;

const FIXTURE_FLAGS = [
  "--posix-picker-master",
  "--posix-connector-picker",
  "--posix-cancellable-picker",
  "--posix-cancellable-mux-picker",
  "--posix-synthetic-password-picker",
  "--posix-cancellable-workspace-snapshot",
  "--dev-interactive-terminal",
  "--fixture-local-account",
  "--fixture-override-host",
  "--fixture-override-user",
  "--fixture-override-port",
  "--fixture-connector-image",
  "--fixture-connector-path",
  "--provider-service",
  "--opencode-service",
  "--agent-fixture",
  "--agent-sha256",
  "--installed-agent-state",
  "--client-relay-fixture",
  "--codex-fixture",
  "--pi-fixture",
  "--opencode-v1-fixture",
  "--paired-peer-fixture",
  "--git-advertisement-fixture",
  "--git-upload-fixture",
  "--git-tracked-push-fixture",
  "--deployment-stage-fixture",
  "--identity-agent-path",
];

function profileOf(fixture: ProductionFixture): SshOwnerProductionProfile {
  return { ...fixture.profile, kind: "desktop-packaged" };
}

async function withPersistence<A, E>(
  fixture: ProductionFixture,
  run: (sql: Sql) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = makeSqlitePersistenceLive(join(fixture.stateDirectory, "state.sqlite"), {
    worker: false,
  }).pipe(Layer.provide(NodeServices.layer));
  return Effect.runPromise(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
      Effect.provideService(run(sql), SqlClient.SqlClient, sql),
    ).pipe(Effect.provide(layer)),
  );
}

const start = (fixture: ProductionFixture, sql: Sql, path: string, deadlineMs?: number) =>
  startOrAttachSshOwnerProduction({
    artifact: fixture.artifact(path, "desktop-packaged"),
    facts: resolveSshOwnerLaunchFacts(profileOf(fixture)),
    sql,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0)) await fn();
});

/** Whether any live process was started from exactly this fixture binary. */
async function processRunning(binary: string): Promise<boolean> {
  const { stdout } = await promisify(execFile)("ps", ["-Ao", "stat=,command="]);
  return stdout.split("\n").some((row) => !row.trimStart().startsWith("Z") && row.includes(binary));
}

describe("production SSH owner launch mode", () => {
  it("passes only the profile, state dir and fixed facts, with no proof flags", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    vi.stubEnv("BIGBUD_SSH_OWNER_PICKER_PROOF", "1");
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const observation = yield* Effect.promise(() => fixture.observation());
        const facts = resolveSshOwnerLaunchFacts(profileOf(fixture));
        expect(observation.argv[2]).toBe("--production");
        expect(observation.argv[3]).toBe("--profile");
        expect(observation.argv[4]).toBe(facts.profileBindingText);
        expect(observation.argv[5]).toBe("--state-dir");
        expect(observation.argv[6]).toBe(fixture.stateDirectory);
        expect(observation.argv.slice(7)).toEqual([
          "--ssh",
          "/usr/bin/ssh",
          "--keyscan",
          "/usr/bin/ssh-keyscan",
          "--attach-socket",
          facts.socketPath,
        ]);
        for (const positional of [
          facts.target?.targetId,
          "127.0.0.1",
          "2222",
          "tester",
          facts.target?.identityFile,
          facts.target?.knownHostsFile,
        ]) {
          expect(observation.argv).not.toContain(positional);
        }
        for (const flag of FIXTURE_FLAGS) expect(observation.argv).not.toContain(flag);
        expect(observation.argv).not.toContain("--workspace-root");
        expect(observation.argv).not.toContain("--dev-interactive-terminal");
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("never propagates the proof environment into the production owner", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    vi.stubEnv("BIGBUD_SSH_OWNER_PICKER_PROOF", "1");
    vi.stubEnv("BIGBUD_SSH_OWNER_PICKER_JUMP", "approved-disposable");
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const observation = yield* Effect.promise(() => fixture.observation());
        expect(observation.env).not.toHaveProperty("BIGBUD_SSH_OWNER_PICKER_PROOF");
        expect(observation.env).not.toHaveProperty("BIGBUD_SSH_OWNER_PICKER_JUMP");
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("forwards the owner-selected v2 service binding beside the v1 one", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const profile = {
      ...profileOf(fixture),
      workspaceRoot: fixture.root,
      opencodeService: { binaryPath: "/opt/opencode-v1" },
      opencodeV2Service: { binaryPath: "/opt/opencode-v2" },
    };
    const facts = resolveSshOwnerLaunchFacts(profile);
    expect(facts.opencodeV2Service).toEqual({ binaryPath: "/opt/opencode-v2" });
    const argv = pickerProofLaunchArgs(
      {
        binary: "/opt/bigbud-ssh-owner",
        lockFile: facts.lockFile,
        sshBinary: "/usr/bin/ssh",
        keyscanBinary: "/usr/bin/ssh-keyscan",
        profileBinding: facts.profileBinding,
        sql: undefined as never,
        workspaceRoot: fixture.root,
        opencodeService: { binaryPath: "/opt/opencode-v1" },
        opencodeV2Service: { binaryPath: "/opt/opencode-v2" },
        productionLaunch: {
          startupDeadlineMs: 1_000,
          profileBindingText: facts.profileBindingText,
          stateDirectory: facts.stateDirectory,
        },
      },
      { profileBindingHex: facts.profileBinding.toString("hex"), aliasArgs: [], scopedArgs: [] },
    );
    expect(argv[argv.indexOf("--opencode-service") + 1]).toBe("/opt/opencode-v1");
    expect(argv[argv.indexOf("--opencode-v2-service") + 1]).toBe("/opt/opencode-v2");
    // No target, host, port, user, identity or known-hosts argument is accepted.
    expect(argv).not.toContain(facts.target?.targetId);
    expect(argv).not.toContain("127.0.0.1");
  });

  it("refuses a relative v2 binding and a v2 binding without a workspace", () => {
    const fixtureProfile = {
      stateDirectory: "/tmp/bigbud-oc-profile",
      kind: "desktop-packaged" as const,
    };
    expect(() =>
      resolveSshOwnerLaunchFacts({
        ...fixtureProfile,
        workspaceRoot: "/srv/work",
        opencodeV2Service: { binaryPath: "opencode-v2" },
      }),
    ).toThrow(/absolute executable/);
    expect(() =>
      resolveSshOwnerLaunchFacts({
        ...fixtureProfile,
        opencodeV2Service: { binaryPath: "/opt/opencode-v2" },
      }),
    ).toThrow(/absolute executable/);
  });

  it("preserves the bounded startup deadline in production mode", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("silent");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const started = Date.now();
        const failure = yield* start(fixture, sql, path, 250).pipe(Effect.flip);
        expect(failure).toMatchObject({ failure: "startup-timeout" });
        expect(Date.now() - started).toBeLessThan(5_000);
        // Under load the 250 ms deadline can reap the fake owner before its
        // first statement writes the observation file, so liveness is checked
        // by the unique fixture binary path in the process table as well.
        yield* Effect.promise(() => waitFor(async () => !(await processRunning(path))));
        const observation = yield* Effect.promise(() =>
          readFile(fixture.observationFile, "utf8").then(
            (text) => JSON.parse(text) as { readonly pid: number },
            () => undefined,
          ),
        );
        if (observation) yield* Effect.promise(() => waitForDeath(observation.pid));
      }),
    );
  });
});

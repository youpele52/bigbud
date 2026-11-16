import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RemoteAgentRuntimeOwnersLive } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { profileOwner } from "../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { PtyAdapter } from "../terminal/Services/PTY.ts";
import { RemoteLocalSupervisorPtyLive } from "./localSupervisorLayer.ts";
import { RemoteTerminalAvailabilityLive } from "./terminalAvailability.ts";
import {
  localSupervisorTestIdentity,
  localSupervisorTestIdentityLayer,
  localSupervisorTestTarget,
} from "./localSupervisorLayer.test.helpers.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { claimLocalSupervisorAuthorityReservation } from "./localSupervisorAuthority.ts";

vi.mock("../remote-agent/remoteAgentController.ts", async (original) => ({
  ...(await original<typeof import("../remote-agent/remoteAgentController.ts")>()),
  // Exercise the proven-dead prepared reclamation branch, with real SQL retained ownership.
  isRemoteAgentControllerAlive: async () => false,
}));
let home: string;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp("/tmp/bo-"));
  vi.stubEnv("HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

describe("refused account claim cannot mutate retained terminal ownership", () => {
  it.each(
    (["missing", "foreign"] as const).flatMap((claim) =>
      (["terminal", "prepared"] as const).map((state) => ({ claim, state })),
    ),
  )("preserves $state owner with $claim claim", async ({ claim, state }) => {
    if (claim === "foreign") {
      const foreign = {
        ...localSupervisorTestIdentity,
        authority: { ...localSupervisorTestIdentity.authority, authorityId: "b".repeat(32) },
      };
      const control = makeLocalSupervisorControl({
        homeDir: home,
        targetId: `remote-backend:${foreign.authority.authorityId}`,
      });
      const backendHome = join(home, "backend");
      const backendStateDir = join(backendHome, "state");
      await fs.mkdir(backendStateDir, { recursive: true, mode: 0o700 });
      await claimLocalSupervisorAuthorityReservation(control, foreign, {
        confirmFreshSetup: true,
        backendHome,
        backendStateDir,
      });
    }
    const mutations: ReturnType<typeof vi.spyOn>[] = [];
    const seed = Layer.effectDiscard(
      Effect.gen(function* () {
        const owners = yield* RemoteAgentRuntimeOwners;
        const previous = {
          ...profileOwner(),
          ownerKey: "terminal:pane",
          target: localSupervisorTestTarget,
          state,
          controllerId: "prior-controller",
          controllerPid: process.pid,
          controllerStartedAt: "prior-token",
        };
        yield* Effect.promise(() =>
          owners.bindConnection(localSupervisorTestTarget, "retained", {
            runtime: previous.runtime,
            expectedEpoch: previous.epoch,
          }),
        );
        yield* Effect.promise(() => owners.reserve(previous));
        mutations.push(
          vi.spyOn(owners, "reserve"),
          vi.spyOn(owners, "update"),
          vi.spyOn(owners, "rollbackPrepared"),
        );
      }),
    ).pipe(Layer.provideMerge(RemoteAgentRuntimeOwnersLive));
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        const owners = yield* RemoteAgentRuntimeOwners;
        const before = yield* Effect.promise(() => owners.get("terminal:pane"));
        const runtime = adapter.ownedRuntimeForTarget!("local")!;
        const connect = vi.spyOn(runtime.pool, "getBound");
        const failure = yield* adapter
          .spawn({
            ownerKey: "pane",
            executionTargetId: "local",
            shell: "/bin/sh",
            cwd: "/work",
            cols: 80,
            rows: 24,
            env: {},
          })
          .pipe(Effect.flip);
        expect(failure.message).toMatch(/installation is missing|ownership/);
        for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
        expect(yield* Effect.promise(() => owners.get("terminal:pane"))).toEqual(before);
        expect(connect).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(
          RemoteLocalSupervisorPtyLive.pipe(
            Layer.provideMerge(seed),
            Layer.provideMerge(RemoteTerminalAvailabilityLive),
            Layer.provide(localSupervisorTestIdentityLayer),
            Layer.provide(SqlitePersistenceMemory),
          ),
        ),
      ),
    );
  });
});

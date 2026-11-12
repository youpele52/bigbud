// Exercise sessions admitted by the previous build; production gating has separate tests.
vi.mock("./Manager.shell.direct.policy", async (original) => ({
  ...(await original<typeof import("./Manager.shell.direct.policy")>()),
  assertDirectShellProfileEnabled: () => undefined,
}));
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { join } from "node:path";
import { expect, vi } from "vitest";
import * as NodeSqlite from "../../persistence/NodeSqliteClient";
import Migration from "../../persistence/Migrations/170_DirectShellLaunchOwners";
import { makeDirectShellLaunchOwners } from "../../persistence/Layers/DirectShellLaunchOwners";
import { intent } from "./DirectShellLaunch.dispatch.test.helpers";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { remoteFixture } from "./Manager.shell.remote.test.helpers";
import { FakePtyAdapter, openInput } from "./Manager.test.helpers";
import { resolveShellProfileLaunch } from "./ShellProfiles.launch";
import { runSshCommand } from "../../ssh/sshProcess";

vi.mock("../../ssh/sshProcess", () => ({
  runSshCommand: vi.fn(async (input: { args: string[] }) => ({
    stdout: `\x1e${input.args[3]}\x1f`,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "direct Manager durable recovery",
  (it) => {
    it.effect(
      "a reopened SQL journal fences a new manager before discovery or transport access",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "bigbud-direct-manager-sql-",
          });
          const filename = join(directory, "owners.sqlite");
          const firstDb = ManagedRuntime.make(NodeSqlite.layer({ filename }));
          yield* Effect.addFinalizer(() => Effect.promise(() => firstDb.dispose()));
          yield* Effect.promise(() => firstDb.runPromise(Migration));
          const store = yield* Effect.promise(() =>
            firstDb.runPromise(makeDirectShellLaunchOwners()),
          );
          const stored = intent();
          const requested = stored.launch.requestedProfile;
          const profile = {
            ...requested,
            executable: stored.launch.executable,
            args: stored.launch.args,
            platform: "linux" as const,
            displayName: "zsh",
            availability: "available" as const,
            integration: { status: "disabled" as const },
          };
          const adapter = new FakePtyAdapter();
          const first = yield* remoteFixture({
            directShellOwners: store,
            ptyAdapter: adapter,
            resolveShellProfile: (selection) =>
              Effect.succeed(
                resolveShellProfileLaunch({ host: profile.host, profiles: [profile], selection }),
              ),
          });
          const input = openInput({
            executionTargetId: stored.executionTargetId,
            cwd: "/work",
            shellSelection: { kind: "profile", profileId: profile.profileId },
          });
          expect((yield* first.manager.open(input)).status).toBe("running");
          yield* Effect.promise(() => firstDb.dispose());
          const secondDb = ManagedRuntime.make(NodeSqlite.layer({ filename }));
          yield* Effect.addFinalizer(() => Effect.promise(() => secondDb.dispose()));
          const recovered = yield* Effect.promise(() =>
            secondDb.runPromise(makeDirectShellLaunchOwners()),
          );
          const second = yield* remoteFixture({
            directShellOwners: recovered,
            ptyAdapter: adapter,
            resolveShellProfile: () => Effect.die("Recovery must not rediscover or create."),
          });
          vi.mocked(runSshCommand).mockClear();
          const result = yield* second.manager.open(input).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(adapter.spawnInputs).toHaveLength(1);
          expect(runSshCommand).not.toHaveBeenCalled();
          const owner = yield* Effect.promise(() =>
            recovered.get(directShellOwnerKey("thread-1", "default")),
          );
          expect(owner?.state).toBe("may-have-been-sent");
          expect(owner?.intent.launch.requestedProfile).toEqual(requested);
        }),
    );
  },
);

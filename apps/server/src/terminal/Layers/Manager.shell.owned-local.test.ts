import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Scope } from "effect";
import { expect } from "vitest";
import { makeTerminalManagerWithOptions } from "./Manager.process.ts";
import { PersistentLocalAdapter } from "./Manager.owned-runtime.test.helpers.ts";
import { historyLogPath, openInput, waitFor } from "./Manager.test.helpers.ts";
import { LOCAL_SHELL_HOST, shellProfileId } from "./ShellProfiles.identity.ts";
import type { ResolvedShellProfileLaunch } from "./ShellProfiles.launch.ts";
import { localSupervisorLaunch } from "../../remote-backend/localSupervisorLaunch.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })("owned local shell intent", (it) => {
  it.effect(
    "reattaches an explicit local profile in the authority scope without confirming it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "owned-local-profile-" });
        const adapter = new PersistentLocalAdapter();
        const shell = "/bin/bash";
        const args = ["--noprofile"];
        const profileId = shellProfileId(LOCAL_SHELL_HOST, shell, args, "linux");
        const selection = { kind: "profile", profileId } as const;
        const launch: ResolvedShellProfileLaunch = {
          shell,
          args,
          platform: "linux",
          dropPathMode: "posix",
          identity: {
            host: LOCAL_SHELL_HOST,
            selection,
            profileId,
            kind: "bash",
            integration: { status: "disabled" },
          },
        };
        const original = adapter.spawn.bind(adapter);
        adapter.spawn = (input) =>
          original(input).pipe(
            Effect.map((process) => {
              const ownerKey = `terminal:${input.ownerKey}`;
              const owner = adapter.ownership.rows.get(ownerKey)!;
              if (!input.recoverOnly)
                adapter.ownership.rows.set(ownerKey, {
                  ...owner,
                  shellLaunch: localSupervisorLaunch(
                    { ...input, shell, args },
                    adapter.ownership.runtime.targetId,
                  ),
                });
              const requestedProfile =
                adapter.ownership.rows.get(ownerKey)!.shellLaunch!.requestedProfile!;
              return Object.assign(process, {
                shellUnconfirmedLaunch: { status: "unconfirmed" as const, requestedProfile },
              });
            }),
          );
        let inventoryUnavailable = false;
        const make = () =>
          makeTerminalManagerWithOptions({
            logsDir,
            ptyAdapter: adapter,
            resolveShellProfile: () => Effect.succeed(inventoryUnavailable ? null : launch),
            subprocessPollIntervalMs: 60_000,
            agentDetector: () => Effect.succeed(new Map()),
            subprocessChecker: () => Effect.succeed(false),
          });
        const firstScope = yield* Scope.make("sequential");
        const first = yield* make().pipe(Effect.provideService(Scope.Scope, firstScope));
        const input = openInput({ shellSelection: selection });
        const opened = yield* first.open(input);
        expect(opened.shellLaunchIdentity).toBeUndefined();
        expect(opened.shellUnconfirmedLaunch?.requestedProfile.host.kind).toBe("agent");
        inventoryUnavailable = true;
        expect((yield* first.open(input)).pid).toBe(opened.pid);
        expect(
          yield* first
            .open(openInput({ shellSelection: { kind: "profile", profileId: "wrong" } }))
            .pipe(Effect.isFailure),
        ).toBe(true);
        adapter.processes[0]!.emitData("intent history\n");
        yield* waitFor(fs.exists(historyLogPath(logsDir)));
        yield* Scope.close(firstScope, Exit.void);
        const secondScope = yield* Scope.make("sequential");
        const second = yield* make().pipe(Effect.provideService(Scope.Scope, secondScope));
        const restored = yield* second.open(input);
        expect(restored.pid).toBe(opened.pid);
        expect(restored.shellLaunchIdentity).toBeUndefined();
        expect(restored.shellUnconfirmedLaunch).toEqual(opened.shellUnconfirmedLaunch);
        expect(adapter.processes).toHaveLength(1);
        expect(adapter.spawnInputs.at(-1)?.recoverOnly).toBe(true);
        yield* Scope.close(secondScope, Exit.void);
      }),
  );
});

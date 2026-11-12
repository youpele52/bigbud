import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vitest";
import { wslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import type {
  ShellSelection,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import { LocalShellDiscoveryError } from "../Services/LocalShellProfiles";
import { LOCAL_SHELL_HOST, shellProfileId } from "./ShellProfiles.identity";
import { resolveShellProfileLaunch, ShellProfileResolutionError } from "./ShellProfiles.launch";
import { createManager, openInput, restartInput, waitFor } from "./Manager.test.helpers";

const executable = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const args = ["-NoLogo", "-NoExit", "-Command", "Write-Output 'profile argument'"];
const profile: TerminalShellProfile = {
  profileId: shellProfileId(LOCAL_SHELL_HOST, executable, args, "win32"),
  host: LOCAL_SHELL_HOST,
  kind: "pwsh",
  displayName: "PowerShell 7",
  executable,
  args,
  platform: "win32",
  availability: "available",
  integration: { status: "unknown" },
};
const selection = { kind: "profile", profileId: profile.profileId } as const;
const resolve = (selected: ShellSelection) =>
  Effect.try({
    try: () =>
      resolveShellProfileLaunch({
        host: LOCAL_SHELL_HOST,
        selection: selected,
        profiles: [profile],
      }),
    catch: () => new ShellProfileResolutionError({ reason: "missing-profile" }),
  });

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "local explicit shell profiles",
  (it) => {
    it.effect(
      "passes the exact executable and argv, and publishes actual identity only after spawn",
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
            resolveShellProfile: resolve,
          });
          const opened = yield* manager.open(openInput({ shellSelection: selection }));
          expect(ptyAdapter.spawnInputs).toHaveLength(1);
          expect(ptyAdapter.spawnInputs[0]).toMatchObject({ shell: executable, args });
          expect(opened.shellLaunchIdentity).toMatchObject({
            host: LOCAL_SHELL_HOST,
            selection,
            profileId: profile.profileId,
            kind: "pwsh",
          });
          expect(opened.dropPathMode).toBe("powershell");
          expect((yield* manager.snapshot(openInput())).shellLaunchIdentity).toEqual(
            opened.shellLaunchIdentity,
          );
          const event = (yield* getEvents).find((event) => event.type === "started");
          expect(event?.type === "started" && event.snapshot.shellLaunchIdentity).toEqual(
            opened.shellLaunchIdentity,
          );
        }),
    );

    it.effect("a resolved but still pending spawn has no actual shell identity", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
          resolveShellProfile: resolve,
        });
        let release!: () => void;
        ptyAdapter.spawnGate = new Promise<void>((done) => {
          release = done;
        });
        const opening = yield* manager
          .open(openInput({ shellSelection: selection }))
          .pipe(Effect.forkScoped);
        yield* waitFor(Effect.sync(() => ptyAdapter.spawnInputs.length === 1));
        const pending = yield* manager.snapshot(openInput());
        expect(pending.status).toBe("starting");
        expect(pending.shellLaunchIdentity).toBeUndefined();
        expect((yield* getEvents).some((event) => event.type === "started")).toBe(false);
        release();
        expect((yield* Fiber.join(opening)).shellLaunchIdentity?.profileId).toBe(profile.profileId);
      }),
    );

    it.effect("explicit ENOENT attempts no fallback and never claims a successful launch", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
          resolveShellProfile: resolve,
        });
        ptyAdapter.spawnFailures.push(new Error("ENOENT: file not found"));
        const failed = yield* manager.open(openInput({ shellSelection: selection }));
        expect(failed.status).toBe("error");
        expect(failed.shellLaunchIdentity).toBeUndefined();
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(ptyAdapter.processes).toHaveLength(0);
        expect((yield* getEvents).some((event) => event.type === "started")).toBe(false);
      }),
    );

    it.effect("preflights missing profiles before killing or preparing a live replacement", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, { resolveShellProfile: resolve });
        const opened = yield* manager.open(openInput());
        let preparations = 0;
        Object.assign(ptyAdapter.processes[0]!, {
          prepareRestart: async () => {
            preparations++;
          },
        });
        const failed = yield* manager
          .restart(
            restartInput({
              shellSelection: { kind: "profile", profileId: "missing" },
            }),
          )
          .pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        if (failed._tag === "Failure")
          expect(failed.failure).toMatchObject({
            _tag: "TerminalExecutionTargetError",
            reason: "restartNotStarted",
          });
        expect(ptyAdapter.processes[0]!.killSignals).toEqual([]);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(preparations).toBe(0);
        expect((yield* manager.snapshot(openInput())).runtimeGeneration).toBe(
          opened.runtimeGeneration,
        );
      }),
    );

    it.effect(
      "discovery failures translate to normal target errors without stopping the shell",
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter } = yield* createManager(5, {
            resolveShellProfile: () =>
              Effect.fail(new LocalShellDiscoveryError({ reason: "timed-out" })),
          });
          yield* manager.open(openInput());
          const failed = yield* manager
            .restart(restartInput({ shellSelection: selection }))
            .pipe(Effect.result);
          expect(failed._tag).toBe("Failure");
          if (failed._tag === "Failure") {
            expect(failed.failure._tag).toBe("TerminalExecutionTargetError");
            expect(failed.failure.message).toContain("Refresh profiles");
          }
          expect(ptyAdapter.processes[0]!.killSignals).toEqual([]);
        }),
    );

    it.effect(
      "old factory injection remains optional for legacy and rejects explicit choice clearly",
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter } = yield* createManager();
          const failed = yield* manager
            .open(openInput({ shellSelection: selection }))
            .pipe(Effect.result);
          expect(failed._tag).toBe("Failure");
          expect(ptyAdapter.spawnInputs).toHaveLength(0);
          const opened = yield* manager.open(openInput());
          expect(opened.status).toBe("running");
          expect(opened.shellLaunchIdentity).toMatchObject({
            host: LOCAL_SHELL_HOST,
            selection: { kind: "legacy-auto" },
            profileId: null,
          });
        }),
    );

    it.effect(
      "restart without a choice revalidates and retains the last actual explicit selection",
      () =>
        Effect.gen(function* () {
          let resolutions = 0;
          const { manager, ptyAdapter } = yield* createManager(5, {
            resolveShellProfile: (selection) => {
              resolutions++;
              return resolve(selection);
            },
          });
          const opened = yield* manager.open(openInput({ shellSelection: selection }));
          const restarted = yield* manager.restart(restartInput());
          expect(resolutions).toBe(2);
          expect(restarted.shellLaunchIdentity).toEqual(opened.shellLaunchIdentity);
          expect(ptyAdapter.spawnInputs[1]).toMatchObject({ shell: executable, args });
          expect(ptyAdapter.processes[0]!.killSignals).toEqual(["SIGTERM"]);
          const legacy = yield* manager.restart(
            restartInput({ shellSelection: { kind: "legacy-auto" } }),
          );
          expect(legacy.shellLaunchIdentity?.selection).toEqual({ kind: "legacy-auto" });
          expect(resolutions).toBe(2);
        }),
    );

    for (const present of [true, false]) {
      it.effect(`processless open retains the actual profile (available=${present})`, () =>
        Effect.gen(function* () {
          let available = true;
          const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
            resolveShellProfile: (selected) =>
              available
                ? resolve(selected)
                : Effect.fail(new ShellProfileResolutionError({ reason: "missing-profile" })),
          });
          const opened = yield* manager.open(openInput({ shellSelection: selection }));
          ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
          yield* waitFor(
            Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
          );
          available = present;
          const reopened = yield* manager.open(openInput()).pipe(Effect.result);
          if (present) {
            expect(reopened._tag).toBe("Success");
            if (reopened._tag === "Success")
              expect(reopened.success.shellLaunchIdentity).toEqual(opened.shellLaunchIdentity);
            expect(ptyAdapter.spawnInputs[1]).toMatchObject({ shell: executable, args });
          } else {
            expect(reopened._tag).toBe("Failure");
            expect(ptyAdapter.spawnInputs).toHaveLength(1);
          }
        }),
      );
    }

    it.effect(
      "a failed replacement retains the previous actual identity, not the requested one",
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter } = yield* createManager(5, { resolveShellProfile: resolve });
          const opened = yield* manager.open(openInput());
          ptyAdapter.spawnFailures.push(new Error("ENOENT"));
          const failed = yield* manager.restart(restartInput({ shellSelection: selection }));
          expect(failed.status).toBe("error");
          expect(failed.shellLaunchIdentity).toEqual(opened.shellLaunchIdentity);
          expect(ptyAdapter.spawnInputs).toHaveLength(2);
          expect(ptyAdapter.processes).toHaveLength(1);
        }),
    );

    it.effect("ordinary live open without selection does not revalidate or spawn", () =>
      Effect.gen(function* () {
        let resolutions = 0;
        const { manager, ptyAdapter } = yield* createManager(5, {
          resolveShellProfile: (selection) => {
            resolutions++;
            return resolve(selection);
          },
        });
        const opened = yield* manager.open(openInput({ shellSelection: selection }));
        const reattached = yield* manager.open(
          openInput({
            executionTargetId: "ssh:unavailable",
            cwd: "/not-a-real-folder",
          }),
        );
        expect(reattached.shellLaunchIdentity).toEqual(opened.shellLaunchIdentity);
        expect(reattached.runtimeGeneration).toBe(opened.runtimeGeneration);
        expect(resolutions).toBe(1);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(ptyAdapter.processes[0]!.killSignals).toEqual([]);
      }),
    );

    it.effect(
      "same known explicit profile reattaches without rediscovery after it disappears",
      () =>
        Effect.gen(function* () {
          let present = true;
          let resolutions = 0;
          const { manager, ptyAdapter } = yield* createManager(5, {
            resolveShellProfile: (selected) => {
              resolutions++;
              return present
                ? resolve(selected)
                : Effect.fail(new ShellProfileResolutionError({ reason: "missing-profile" }));
            },
          });
          const opened = yield* manager.open(openInput({ shellSelection: selection }));
          present = false;
          const reattached = yield* manager.open(openInput({ shellSelection: selection }));
          expect(reattached.runtimeGeneration).toBe(opened.runtimeGeneration);
          expect(resolutions).toBe(1);
          const failed = yield* manager.restart(restartInput()).pipe(Effect.result);
          expect(failed._tag).toBe("Failure");
          expect(resolutions).toBe(2);
          expect(ptyAdapter.processes[0]!.killSignals).toEqual([]);
        }),
    );

    it.effect("different or unproven explicit profile cannot silently reattach", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, { resolveShellProfile: resolve });
        yield* manager.open(openInput());
        const unproven = yield* manager
          .open(openInput({ shellSelection: selection }))
          .pipe(Effect.result);
        expect(unproven._tag).toBe("Failure");
        yield* manager.restart(restartInput({ shellSelection: selection }));
        const different = yield* manager
          .open(openInput({ shellSelection: { kind: "profile", profileId: "other" } }))
          .pipe(Effect.result);
        expect(different._tag).toBe("Failure");
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        expect(ptyAdapter.processes[1]!.killSignals).toEqual([]);
      }),
    );

    it.effect("operation retries are idempotent but changed shell selection is a mismatch", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, { resolveShellProfile: resolve });
        const request = restartInput({ operationId: "profile-restart", shellSelection: selection });
        const opened = yield* manager.restart(request);
        const retry = yield* manager.restart(request);
        expect(retry.runtimeGeneration).toBe(opened.runtimeGeneration);
        const mismatch = yield* manager
          .restart({
            ...request,
            shellSelection: { kind: "legacy-auto" },
          })
          .pipe(Effect.result);
        expect(mismatch._tag).toBe("Failure");
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(ptyAdapter.processes[0]!.killSignals).toEqual([]);
      }),
    );

    for (const target of [
      "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      wslTerminalTargetId("Ubuntu"),
      "remote-agent:server-1",
    ]) {
      it.effect(
        `rejects explicit ${target} open/restart before local discovery, remote probes or stop`,
        () =>
          Effect.gen(function* () {
            let resolutions = 0;
            const { manager, ptyAdapter } = yield* createManager(5, {
              resolveShellProfile: (selection) => {
                resolutions++;
                return resolve(selection);
              },
            });
            const rejected = yield* manager
              .open(
                openInput({
                  executionTargetId: target,
                  shellSelection: selection,
                }),
              )
              .pipe(Effect.result);
            expect(rejected._tag).toBe("Failure");
            expect(ptyAdapter.spawnInputs).toHaveLength(0);
            const opened = yield* manager.open(openInput());
            const rejectedAttach = yield* manager
              .open(openInput({ executionTargetId: target, shellSelection: selection }))
              .pipe(Effect.result);
            expect(rejectedAttach._tag).toBe("Failure");
            const failed = yield* manager
              .restart(
                restartInput({
                  executionTargetId: target,
                  shellSelection: selection,
                }),
              )
              .pipe(Effect.result);
            expect(failed._tag).toBe("Failure");
            expect(resolutions).toBe(0);
            expect(ptyAdapter.processes[0]!.killSignals).toEqual([]);
            expect(ptyAdapter.spawnInputs).toHaveLength(1);
            expect((yield* manager.snapshot(openInput())).runtimeGeneration).toBe(
              opened.runtimeGeneration,
            );
          }),
      );
    }
  },
);

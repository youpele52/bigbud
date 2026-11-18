import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import { wslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import type { LocalShellProfilesShape } from "../Services/LocalShellProfiles";
import { ShellProfileDiscoveryError, type ShellProfileTarget } from "../Services/ShellProfiles";
import { LOCAL_SHELL_HOST, shellProfileId } from "./ShellProfiles.identity";
import { remoteShellHost } from "./ShellProfiles.remote.identity";
import { makeShellProfiles, MAX_SHELL_PROFILES, MAX_SHELL_PROFILE_HOSTS } from "./ShellProfiles";

const ssh = (user: string): ShellProfileTarget => ({
  executionTargetId: `ssh:host=devbox&user=${user}&port=22&auth=ssh-key`,
});
const wsl = (username: string, uid = 1000): ShellProfileTarget => ({
  executionTargetId: wslTerminalTargetId("Ubuntu"),
  wslIdentity: { distribution: "Ubuntu", username, uid },
});
function profile(target?: ShellProfileTarget): TerminalShellProfile {
  const host = target ? remoteShellHost(target) : LOCAL_SHELL_HOST;
  return {
    profileId: shellProfileId(host, "/bin/bash", [], "linux"),
    host,
    executable: "/bin/bash",
    args: [],
    kind: "bash",
    displayName: "Bash",
    platform: "linux",
    availability: "available",
    integration: { status: "unavailable", reason: "not-qualified" },
  };
}
const noLocal: LocalShellProfilesShape = {
  list: Effect.die("must not substitute local inventory"),
  revalidate: Effect.die("must not substitute local launch discovery"),
  invalidate: Effect.die("must not invalidate unrelated local inventory"),
};

describe("execution-host shell inventories", () => {
  it("delegates local caching and fresh launch preflight to the local service", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const calls: string[] = [];
        const service = yield* makeShellProfiles(
          {
            list: Effect.sync(() => {
              calls.push("list");
              return [profile()];
            }),
            revalidate: Effect.sync(() => {
              calls.push("revalidate");
              return [];
            }),
            invalidate: Effect.sync(() => {
              calls.push("invalidate");
            }),
          },
          () => Effect.die("local must not probe remote"),
        );
        const target = { executionTargetId: "local" };
        expect((yield* service.list(target)).profiles).toHaveLength(1);
        expect((yield* service.revalidate(target)).profiles).toEqual([]);
        yield* service.invalidate(target);
        expect(calls).toEqual(["list", "revalidate", "invalidate"]);
      }),
    );
  });

  it("isolates SSH accounts and pinned WSL identities, including recreated UIDs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0;
        const service = yield* makeShellProfiles(noLocal, (target) =>
          Effect.sync(() => {
            calls++;
            return [profile(target)];
          }),
        );
        for (const target of [
          ssh("alice"),
          ssh("bob"),
          wsl("alice"),
          wsl("bob"),
          wsl("alice", 1001),
        ]) {
          const first = yield* service.list(target);
          const copy = {
            ...target,
            ...(target.wslIdentity ? { wslIdentity: { ...target.wslIdentity } } : {}),
          };
          expect(yield* service.list(copy)).toEqual(first);
          expect(first.host).toEqual(remoteShellHost(target));
        }
        expect(calls).toBe(5);
      }),
    );
  });

  it("bounds remote display cache capacity without retaining an unbounded target map", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const calls: string[] = [];
        const service = yield* makeShellProfiles(noLocal, (target) =>
          Effect.sync(() => {
            calls.push(target.executionTargetId);
            return [];
          }),
        );
        for (let index = 0; index <= MAX_SHELL_PROFILE_HOSTS; index++) {
          yield* service.list(ssh(`account${index}`));
        }
        yield* service.list(ssh(`account${MAX_SHELL_PROFILE_HOSTS}`));
        expect(calls).toHaveLength(MAX_SHELL_PROFILE_HOSTS + 1);
        yield* service.list(ssh("account0"));
        expect(calls).toHaveLength(MAX_SHELL_PROFILE_HOSTS + 2);
      }),
    );
  });

  it("copies pinned identity before a remote probe can yield", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const identity = { distribution: "Ubuntu", username: "alice", uid: 1000 };
        const target = { executionTargetId: wslTerminalTargetId("Ubuntu"), wslIdentity: identity };
        const service = yield* makeShellProfiles(noLocal, (copied) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            expect(copied.wslIdentity).toEqual(wsl("alice").wslIdentity);
            return [profile(copied)];
          }),
        );
        const pending = yield* Effect.forkChild(service.list(target));
        yield* Deferred.await(entered);
        identity.username = "bob";
        identity.uid = 1001;
        yield* Deferred.succeed(release, undefined);
        const inventory = yield* Fiber.join(pending);
        expect(inventory.host).toEqual(remoteShellHost(wsl("alice")));
        expect(yield* service.list(wsl("alice"))).toEqual(inventory);
      }),
    );
  });

  it("expires successful remote display inventory after five minutes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0;
        const service = yield* makeShellProfiles(noLocal, () =>
          Effect.sync(() => {
            calls++;
            return [];
          }),
        );
        yield* service.list(ssh("alice"));
        yield* TestClock.adjust("299 seconds");
        yield* service.list(ssh("alice"));
        expect(calls).toBe(1);
        yield* TestClock.adjust("1 second");
        yield* service.list(ssh("alice"));
        expect(calls).toBe(2);
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
    );
  });

  it("coalesces equivalent remote display reads but never caches failed probes as empty", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const service = yield* makeShellProfiles(noLocal, () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* new ShellProfileDiscoveryError({ reason: "timed-out" });
            }
            return [];
          }),
        );
        const first = yield* Effect.forkChild(Effect.result(service.list(ssh("alice"))));
        yield* Deferred.await(entered);
        const second = yield* Effect.forkChild(Effect.result(service.list(ssh("alice"))));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(first))._tag).toBe("Failure");
        expect((yield* Fiber.join(second))._tag).toBe("Failure");
        expect(calls).toBe(1);
        expect((yield* service.list(ssh("alice"))).profiles).toEqual([]);
        expect(calls).toBe(2);
      }),
    );
  });

  it("invalidates stale display data and always probes again for launch, including failure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0;
        let fail = false;
        const target = ssh("alice");
        const service = yield* makeShellProfiles(noLocal, () =>
          Effect.suspend(() => {
            calls++;
            return fail
              ? Effect.fail(new ShellProfileDiscoveryError({ reason: "probe-failed" }))
              : Effect.succeed([profile(target)]);
          }),
        );
        yield* service.list(target);
        yield* service.revalidate(target);
        expect(calls).toBe(2);
        yield* service.list(target);
        fail = true;
        expect((yield* Effect.result(service.revalidate(target)))._tag).toBe("Failure");
        fail = false;
        yield* service.list(target);
        expect(calls).toBe(5);
      }),
    );
  });

  it("rejects cross-host, duplicate, oversized and malformed inventories", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const target = ssh("alice");
        const valid = profile(target);
        for (const profiles of [
          [profile()],
          [profile(ssh("bob"))],
          [valid, valid],
          Array.from({ length: MAX_SHELL_PROFILES + 1 }, () => valid),
          [{ ...valid, executable: "bad\npath" }],
        ]) {
          const service = yield* makeShellProfiles(noLocal, () => Effect.succeed(profiles));
          expect(yield* Effect.flip(service.list(target))).toMatchObject({
            reason: "probe-failed",
          });
        }
      }),
    );
  });

  it("rejects unsupported targets before probing without local fallback", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* makeShellProfiles(noLocal, () => Effect.die("must not probe"));
        for (const target of [
          { executionTargetId: "remote-agent:old-agent" },
          { executionTargetId: "not-a-target" },
          { executionTargetId: wslTerminalTargetId("Ubuntu") },
          { executionTargetId: "local", wslIdentity: wsl("alice").wslIdentity! },
        ]) {
          expect(yield* Effect.flip(service.list(target))).toMatchObject({
            reason: "unsupported-target",
          });
        }
      }),
    );
  });

  it("does not repopulate invalidated remote inventory from an old in-flight result", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const target = ssh("alice");
        let calls = 0;
        const service = yield* makeShellProfiles(noLocal, () =>
          Effect.gen(function* () {
            calls++;
            if (calls > 1) return [];
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return [profile(target)];
          }),
        );
        const stale = yield* Effect.forkChild(service.list(target));
        yield* Deferred.await(entered);
        yield* service.invalidate(target);
        expect((yield* service.list(target)).profiles).toEqual([]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stale);
        expect((yield* service.list(target)).profiles).toEqual([]);
        expect(calls).toBe(2);
      }),
    );
  });

  it("settles cancelled remote discovery and allows a later retry", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let calls = 0;
        const service = yield* makeShellProfiles(noLocal, () =>
          Effect.gen(function* () {
            calls++;
            if (calls > 1) return [];
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        );
        const cancelled = yield* Effect.forkChild(service.list(ssh("alice")));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(cancelled);
        expect(
          (yield* service.list(ssh("alice")).pipe(Effect.timeout("1 second"))).profiles,
        ).toEqual([]);
        expect(calls).toBe(2);
      }),
    );
  });
});

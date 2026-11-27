import { execFileSync } from "node:child_process";
import { copyFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { makeProductionFixture } from "./sshOwnerProductionClient.fixture.ts";
import { start, withPersistence } from "./sshOwner.productionClient.attach.fixture.ts";

/**
 * W6 defects (a) and (b) against the real owner binary (desktop-packaged, surviving):
 * the drain's owner shutdown closes everything and the owner exits, its socket and
 * attach record are gone, and the next backend starts a fresh owner instead of
 * re-attaching. An owner from another install path is refused typed and retires.
 */
// BIGBUD_TEST_SSH_OWNER_BIN: run against a packaged owner (for example the B candidate's).
const owner =
  process.env.BIGBUD_TEST_SSH_OWNER_BIN ??
  fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url));

const ownersUnder = (root: string) => {
  try {
    return execFileSync("pgrep", ["-f", "--", `--state-dir ${root}/`], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};
const gone = (path: string) =>
  lstat(path).then(
    () => false,
    () => true,
  );

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

it.skipIf(!existsSync(owner) || process.platform === "win32")(
  "a drained owner closes everything, exits and is never re-attached",
  async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const facts = resolveSshOwnerLaunchFacts(fixture.profile);
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const first = yield* start(fixture, sql, owner);
        expect(first.mode).toBe("spawned");
        const [pid] = ownersUnder(fixture.root);
        expect(pid).toBeDefined();
        const report = yield* Effect.promise(() => first.shutdownForDrain());
        expect(report).toEqual({ mastersClosed: 0, leasesClosed: 0, attachCleared: true });
        expect(ownersUnder(fixture.root)).toEqual([]);
        expect(yield* Effect.promise(() => gone(facts.socketPath))).toBe(true);
        expect(yield* Effect.promise(() => gone(facts.attachFile))).toBe(true);
        // The next backend finds nothing to attach and starts its own owner.
        const second = yield* start(fixture, sql, owner);
        expect(second.mode).toBe("spawned");
        expect(second.ownerEpoch).not.toEqual(first.ownerEpoch);
        yield* Effect.promise(() => second.shutdownForDrain());
      }),
    );
    expect(ownersUnder(fixture.root)).toEqual([]);
  },
  60_000,
);

it.skipIf(!existsSync(owner) || process.platform === "win32")(
  "an owner from another install path is refused, retires and is replaced",
  async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const otherInstall = join(fixture.root, "other-install-bigbud-ssh-owner");
    await copyFile(owner, otherInstall);
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const foreign = yield* start(fixture, sql, otherInstall);
        const [foreignPid] = ownersUnder(fixture.root);
        // A surviving owner outlives a plain backend shutdown (detach).
        yield* foreign.shutdown();
        expect(ownersUnder(fixture.root)).toEqual([foreignPid]);
        const own = yield* start(fixture, sql, owner);
        expect(own.mode).toBe("spawned");
        const owners = ownersUnder(fixture.root);
        expect(owners).toHaveLength(1);
        expect(owners).not.toContain(foreignPid);
        yield* Effect.promise(() => own.shutdownForDrain());
      }),
    );
    expect(ownersUnder(fixture.root)).toEqual([]);
  },
  60_000,
);

// Live (cutover §d1): a real control master to a disposable sshd is closed by the drain.
// BIGBUD_TEST_SSH_OWNER_DRAIN_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":…}' (key and pin in a private directory, never ~/.ssh).
const live = process.env.BIGBUD_TEST_SSH_OWNER_DRAIN_TARGET;
const sshUnder = (ownerPid: string) => {
  try {
    return execFileSync("pgrep", ["-P", ownerPid, "ssh"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

it.skipIf(!existsSync(owner) || process.platform === "win32" || live === undefined)(
  "the drain closes a live control master and the owner exits with it",
  async () => {
    const target = JSON.parse(live!) as {
      host: string;
      port: number;
      user: string;
      identityFile: string;
      knownHostsFile: string;
      cwd: string;
    };
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const targetId = `ssh:host=${target.host}&auth=ssh-key&transport=direct-ssh`;
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, owner);
        const [ownerPid] = ownersUnder(fixture.root);
        const bound = handle.target({
          targetId,
          kind: "structured",
          host: target.host,
          port: target.port,
          user: target.user,
          identityFile: target.identityFile,
          knownHostsFile: target.knownHostsFile,
        });
        yield* Effect.promise(() =>
          bound.listRemoteFolders({ executionTargetId: targetId, path: target.cwd }),
        );
        expect(sshUnder(ownerPid!)).not.toBe("");
        const report = yield* Effect.promise(() => handle.shutdownForDrain());
        expect(report.mastersClosed).toBe(1);
        expect(report.attachCleared).toBe(true);
        expect(ownersUnder(fixture.root)).toEqual([]);
        expect(sshUnder(ownerPid!)).toBe("");
        const next = yield* start(fixture, sql, owner);
        expect(next.mode).toBe("spawned");
        yield* Effect.promise(() => next.shutdownForDrain());
      }),
    );
    expect(ownersUnder(fixture.root)).toEqual([]);
  },
  90_000,
);

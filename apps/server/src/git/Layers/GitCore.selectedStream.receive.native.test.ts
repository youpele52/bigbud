import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Path } from "effect";
import { expect, it, vi } from "vitest";

import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../../persistence/Services/ProjectionProjects.ts";
import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import { activateDevSshOwner } from "../../ssh/sshOwnerDevMode.fixture.ts";
import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import type { ExecuteGitInput } from "../Services/GitCore.ts";
import { makeGitHelpers } from "./GitCoreExecutor.ts";
import { InitiatingFetchOwner } from "./GitCore.initiatingTransport.ts";
import { makeProductionInitiatingFetchBinding } from "./GitCore.selectedStream.production.ts";
import { makeProductionPushBinding } from "./GitCore.selectedStream.receive.ts";
import { makeGitStatusOps } from "./GitStatus.ts";

// U15 push live run against a disposable sshd (for example the OrbStack Debian guest), with
// target/debug/bigbud-ssh-owner built on this host. `cwd` is the workspace root holding the bare
// `repo.git`. The remote is scp-style through a config alias (`bbu15r`) that this test writes
// into a private HOME, so routing and serving both go through `~/.ssh/config` resolution. All
// remote reads and writes (including "another client" moving the remote) use the owner.
// BIGBUD_TEST_U15_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":"/tmp/u15r/ws","remoteBinary":"/unused"}'
const external = readExternalV2Target(process.env.BIGBUD_TEST_U15_EXTERNAL_TARGET);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

const execute = (input: ExecuteGitInput) =>
  Effect.sync(() => {
    try {
      const stdout = execFileSync("git", [...input.args], { cwd: input.cwd, encoding: "utf8" });
      return { code: 0, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string };
      return {
        code: failed.status ?? 1,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }
  });

// Structured target, then an alias target resolved by the owner from a real-user-style
// `~/.ssh/config` (U17 production scope: real home, Include, `~/.ssh/keys/...`).
it.skipIf(external === undefined).each([false, true])(
  "pushes, refuses stale, surfaces non-fast-forward and publishes a branch (alias target: %s)",
  async (aliasTarget) => {
    const layout = aliasTarget ? { aliasFirstTarget: true, userProfileLayout: true } : {};
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const { descriptor, cwd: workspaceRoot } = targets[0]!;
        // An alias descriptor names the bare alias; the runtime target id carries `ssh:`.
        const targetId =
          descriptor.kind === "alias" ? `ssh:${descriptor.targetId}` : descriptor.targetId;
        const bound = handle.target(descriptor);
        const trust = await bound.inspectTrust();
        if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
        // Selects the owner for initiating Git (as production activation does) once launched.
        activateDevSshOwner();
        // The alias target's own fixture home (`<home>/.ssh/keys/<key>`) is the HOME, and the
        // remote is spelled with that alias; otherwise a private HOME declares `bbu15r`.
        const home = aliasTarget
          ? resolve(descriptor.identityFile, "../../..")
          : mkdtempSync(join(tmpdir(), "bbu15r-home-"));
        const remoteHost = aliasTarget ? descriptor.targetId : "bbu15r";
        const scratch = mkdtempSync(join(tmpdir(), "bbu15r-"));
        if (!aliasTarget) {
          mkdirSync(join(home, ".ssh"), { mode: 0o700 });
          writeFileSync(
            join(home, ".ssh", "config"),
            `Host bbu15r\n  HostName ${descriptor.host}\n  User ${descriptor.user}\n  Port ${descriptor.port}\n`,
          );
        }
        vi.stubEnv("HOME", home);
        try {
          const registration = {
            handle,
            descriptorFor: async () => descriptor,
          } as unknown as SshOwnerProductionRegistration;
          const production = {
            owner: () => registration,
            records: async () => [{ executionTargetId: targetId, workspaceRoot }],
          };
          const binding = {
            ...makeProductionInitiatingFetchBinding(production),
            push: makeProductionPushBinding(production),
          };
          const projects = {
            listAll: () => Effect.succeed([{ executionTargetId: targetId, deletedAt: null }]),
          } as unknown as ProjectionProjectRepositoryShape;
          // Every remote read and write below goes through the owner; nothing dials directly.
          const fetch = (cwd: string, refspecs: ReadonlyArray<string> = []) =>
            binding.fetch(
              { cwd, remoteName: "origin", refspecs, timeoutMs: 30_000 },
              new AbortController().signal,
            );
          const push = (cwd: string) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const ops = yield* makeGitStatusOps(
                  makeGitHelpers(execute),
                  yield* Path.Path,
                  "initiating",
                );
                return yield* ops.pushCurrentBranch(cwd, null);
              }).pipe(
                Effect.provideService(InitiatingFetchOwner, binding),
                Effect.provideService(ProjectionProjectRepository, projects),
                Effect.provide(Path.layer),
              ),
            );
          // 1. scp alias remote; a fetch through the upload lease seeds the tracking ref.
          const clone = async (name: string) => {
            const cwd = join(scratch, name);
            mkdirSync(cwd);
            git(cwd, "init", "-q", "-b", "scratch");
            git(cwd, "remote", "add", "origin", `${remoteHost}:${workspaceRoot}/repo.git`);
            await fetch(cwd);
            git(cwd, "checkout", "-q", "-b", "main", "--track", "origin/main");
            return cwd;
          };
          const remoteHead = async (ref = "main") => {
            const probe = await clone(`probe-${Date.now()}-${Math.random()}`);
            await fetch(probe, [`+refs/heads/${ref}:refs/remotes/origin/${ref}`]);
            return git(probe, "rev-parse", `origin/${ref}`);
          };
          const run = `${process.pid}-${Date.now()}`;
          const change = (cwd: string, name: string) => {
            writeFileSync(join(cwd, `${name}-${run}`), name);
            git(cwd, "add", "-A");
            git(cwd, "commit", "-qm", name);
            return git(cwd, "rev-parse", "HEAD");
          };
          const local = await clone("local");
          // 2. An approved fast-forward advances the bare repository.
          const next = change(local, "b");
          await expect(push(local)).resolves.toMatchObject({ status: "pushed", branch: "main" });
          expect(await remoteHead()).toBe(next);
          // 3. Another client moves the remote: the stale expected old OID is refused.
          const other = await clone("other");
          const moved = change(other, "c");
          await expect(push(other)).resolves.toMatchObject({ status: "pushed" });
          change(local, "d");
          await expect(push(local)).rejects.toThrow(
            /remote branch changed since it was last fetched/u,
          );
          expect(await remoteHead()).toBe(moved);
          // 4. After a fetch the push is not stale but diverged: Git's reason is surfaced.
          await fetch(local);
          await expect(push(local)).rejects.toThrow(/rejected: the remote branch has commits/u);
          expect(await remoteHead()).toBe(moved);
          // 5. First publish of a new branch: created on the target, upstream recorded.
          const feature = `feature-${run}`;
          git(local, "checkout", "-q", "--no-track", "-b", feature, "origin/main");
          const published = change(local, "f");
          await expect(push(local)).resolves.toMatchObject({ status: "pushed", setUpstream: true });
          expect(await remoteHead(feature)).toBe(published);
          expect(git(local, "rev-parse", "--abbrev-ref", `${feature}@{upstream}`)).toBe(
            `origin/${feature}`,
          );
        } finally {
          vi.unstubAllEnvs();
          rmSync(scratch, { recursive: true, force: true });
          if (!aliasTarget) rmSync(home, { recursive: true, force: true });
        }
      },
      layout,
    );
  },
  240_000,
);

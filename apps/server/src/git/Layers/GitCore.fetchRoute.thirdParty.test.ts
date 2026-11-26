import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Path } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { routeSelectedFetch } from "./GitCore.fetchRoute.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { registerSshTargetIdSource } from "./GitCore.fetchRoute.hosts.ts";
import {
  InitiatingFetchOwner,
  isInitiatingTransportUnavailable,
} from "./GitCore.initiatingTransport.ts";
import { makeGitHelpers } from "./GitCoreExecutor.ts";
import { makeGitStatusOps } from "./GitStatus.ts";

/**
 * U14 live check: a local repo whose remote is a disposable loopback sshd + bare repo that is
 * NOT a bigbud SSH target fetches as ordinary fenced Git under selection. The user's own
 * repo-local `core.sshCommand` supplies key and trust, as `~/.ssh` would in production.
 */
const SSHD = "/usr/sbin/sshd";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

describe.skipIf(!existsSync(SSHD))("third-party SSH remote under selection (U14)", () => {
  let root: string;
  let sshd: ChildProcess | undefined;
  let port: number;
  let sshCommand: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "bbsshd-"));
    port = await freePort();
    const keygen = (name: string) =>
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, name)]);
    keygen("hostkey");
    keygen("userkey");
    writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "userkey.pub")), {
      mode: 0o600,
    });
    const hostKey = readFileSync(join(root, "hostkey.pub"), "utf8").split(" ").slice(0, 2);
    writeFileSync(join(root, "known_hosts"), `[127.0.0.1]:${port} ${hostKey.join(" ")}\n`);
    writeFileSync(
      join(root, "sshd_config"),
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(root, "hostkey")}`,
        `AuthorizedKeysFile ${join(root, "authorized_keys")}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "StrictModes no",
        `PidFile ${join(root, "pid")}`,
        "",
      ].join("\n"),
    );
    sshd = spawn(SSHD, ["-f", join(root, "sshd_config"), "-D", "-e"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    sshCommand = [
      "ssh",
      `-i ${join(root, "userkey")}`,
      `-p ${port}`,
      "-o BatchMode=yes",
      "-o IdentitiesOnly=yes",
      `-o UserKnownHostsFile=${join(root, "known_hosts")}`,
      "-o StrictHostKeyChecking=yes",
    ].join(" ");
  });

  afterAll(() => {
    sshd?.kill();
    rmSync(root, { recursive: true, force: true });
  });

  function prepare(name: string) {
    const bare = join(root, `${name}.git`);
    const other = join(root, `${name}-other`);
    const work = join(root, `${name}-work`);
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(root, "clone", "-q", bare, other);
    for (const file of ["a", "b"]) {
      writeFileSync(join(other, file), file);
      git(other, "add", file);
      git(other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
      if (file === "a") {
        git(other, "push", "-q", "origin", "HEAD:main");
        git(root, "clone", "-q", bare, work);
        git(work, "remote", "set-url", "origin", `ssh://127.0.0.1${bare}`);
        git(work, "config", "core.sshCommand", sshCommand);
      }
    }
    git(other, "push", "-q", "origin", "HEAD:main");
    return { work, other };
  }

  it("fetches through the user's own SSH setup and advances the tracking ref", async () => {
    const { work, other } = prepare("third");
    await expect(
      routeSelectedFetch(
        {
          operands: { cwd: work, remoteName: "origin", refspecs: [], timeoutMs: 20_000 },
          owner: undefined,
          targets: async () => [{ hosts: ["target.example"] }],
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("fetched");
    expect(git(work, "rev-parse", "origin/main")).toBe(git(other, "rev-parse", "HEAD"));
  });

  it("never dials the same host ambiently once it is a bigbud target", async () => {
    const { work, other } = prepare("target");
    const before = git(work, "rev-parse", "origin/main");
    const error = await routeSelectedFetch(
      {
        operands: { cwd: work, remoteName: "origin", refspecs: [], timeoutMs: 20_000 },
        owner: undefined,
        targets: async () => [{ hosts: ["127.0.0.1"] }],
      },
      new AbortController().signal,
    ).catch((cause: unknown) => cause);
    expect(isInitiatingTransportUnavailable(error)).toBe(true);
    expect(git(work, "rev-parse", "origin/main")).toBe(before);
    expect(before).not.toBe(git(other, "rev-parse", "HEAD"));
  });

  it("background status refresh fetches a non-target SSH remote via the fenced path", async () => {
    const { work, other } = prepare("background");
    const unregister = registerSshTargetIdSource(async () => ["ssh:host=target.example&user=u"]);
    const owner = { fetch: vi.fn(async () => "fetched" as const) };
    const execute = (input: ExecuteGitInput): Effect.Effect<ExecuteGitResult> =>
      Effect.sync(() => {
        try {
          const stdout = execFileSync("git", [...input.args], {
            cwd: input.cwd,
            encoding: "utf8",
            env: { ...process.env, ...input.env },
          });
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
    try {
      // No projection service in this context: the registered source must supply the targets.
      await Effect.runPromise(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const ops = yield* makeGitStatusOps(makeGitHelpers(execute), path, "initiating");
          yield* ops.statusDetails(work);
        }).pipe(Effect.provideService(InitiatingFetchOwner, owner), Effect.provide(Path.layer)),
      );
    } finally {
      unregister();
    }
    expect(owner.fetch).not.toHaveBeenCalled();
    expect(git(work, "rev-parse", "origin/main")).toBe(git(other, "rev-parse", "HEAD"));
  });
});

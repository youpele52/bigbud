import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Path } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activateDevSshOwner } from "../../ssh/sshOwnerDevMode.fixture.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { makeGitHelpers } from "./GitCoreExecutor.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../../persistence/Services/ProjectionProjects.ts";
import {
  InitiatingFetchOwner,
  initiatingTransportUnavailable,
  isInitiatingTransportUnavailable,
} from "./GitCore.initiatingTransport.ts";
import { routeSelectedFetch } from "./GitCore.fetchRoute.ts";
import { classifyRemoteUrl } from "./GitCore.fetchRoute.match.ts";
import { makeGitStatusOps } from "./GitStatus.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, name: string): void {
  writeFileSync(join(cwd, name), name);
  git(cwd, "add", name);
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", name);
}

describe("selected-mode fetch routing by remote transport", () => {
  let root: string;
  beforeEach(() => {
    activateDevSshOwner();
    root = mkdtempSync(join(tmpdir(), "bigbud-local-remote-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("classifies local, SSH (URL and scp-style) and unsupported remotes", () => {
    for (const url of ["https://jugit.example/x.git", "http://h/x", "file:///r", "/r.git"]) {
      expect(classifyRemoteUrl(url)).toEqual({ kind: "local" });
    }
    expect(classifyRemoteUrl("git@GitHub.com:o/r.git")).toEqual({
      kind: "ssh",
      host: "github.com",
      user: "git",
    });
    expect(classifyRemoteUrl("ssh://u@h.example:2222/x")).toEqual({
      kind: "ssh",
      host: "h.example",
      user: "u",
      port: 2222,
    });
    for (const url of ["git://h/x", "ext::ssh h", "fd::3", "", "a\nb"]) {
      expect(classifyRemoteUrl(url)).toEqual({ kind: "unsupported" });
    }
  });

  it("fetches a local repo with a non-SSH remote as ordinary git without an owner session", async () => {
    const bare = join(root, "remote.git");
    const work = join(root, "work");
    const other = join(root, "other");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(root, "clone", "-q", `file://${bare}`, other);
    commit(other, "a");
    git(other, "push", "-q", "origin", "HEAD:main");
    git(root, "clone", "-q", `file://${bare}`, work);
    commit(other, "b");
    git(other, "push", "-q", "origin", "HEAD:main");
    // Ambient SSH selection must not cross the boundary even when set.
    vi.stubEnv("GIT_SSH_COMMAND", "false");

    await expect(
      routeSelectedFetch(
        {
          operands: { cwd: work, remoteName: "origin", refspecs: [], timeoutMs: 10_000 },
          owner: undefined,
          targets: async () => undefined,
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("fetched");
    expect(git(work, "rev-parse", "origin/main")).toBe(git(other, "rev-parse", "HEAD"));
  });

  it("refuses an SSH remote to a bigbud target without an owner", async () => {
    const error = await routeSelectedFetch(
      {
        operands: { cwd: "/repo", remoteName: "origin", refspecs: [], timeoutMs: 5_000 },
        owner: undefined,
        targets: async () => [{ hosts: ["example.com"] }],
      },
      new AbortController().signal,
      { resolveRemoteUrl: async () => "ssh://git@example.com/x.git" },
    ).catch((cause: unknown) => cause);
    expect(isInitiatingTransportUnavailable(error)).toBe(true);
  });

  it("fails closed to the owner when the target set is unknown", async () => {
    const runGit = vi.fn(async () => ({ code: 0, stderr: "" }));
    const error = await routeSelectedFetch(
      {
        operands: { cwd: "/repo", remoteName: "origin", refspecs: [], timeoutMs: 5_000 },
        owner: undefined,
        targets: async () => undefined,
      },
      new AbortController().signal,
      { resolveRemoteUrl: async () => "git@github.com:o/r.git", runGit },
    ).catch((cause: unknown) => cause);
    expect(isInitiatingTransportUnavailable(error)).toBe(true);
    expect(runGit).not.toHaveBeenCalled();
  });

  it("runs a third-party SSH host as fenced, non-interactive local Git (U14)", async () => {
    vi.stubEnv("GIT_SSH_COMMAND", "evil");
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'core.sshCommand=evil'");
    const runGit = vi.fn(
      async (_args: ReadonlyArray<string>, _options: { env: Record<string, string> }) => ({
        code: 0,
        stderr: "",
      }),
    );
    await routeSelectedFetch(
      {
        operands: { cwd: "/repo", remoteName: "origin", refspecs: [], timeoutMs: 60_000 },
        owner: undefined,
        targets: async () => [{ hosts: ["target.example"] }],
      },
      new AbortController().signal,
      {
        resolveRemoteUrl: async () => "git@github.com:o/r.git",
        readGitConfig: async () => undefined,
        runGit,
      },
    );
    const [args, options] = runGit.mock.calls[0]!;
    expect(args.slice(0, 3)).toEqual(["-c", "core.sshCommand=ssh -o BatchMode=yes", "fetch"]);
    expect(options.env.GIT_ALLOW_PROTOCOL).toBe("ssh");
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(options.env.GIT_SSH_COMMAND).toBeUndefined();
    expect(options.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect((options as unknown as { timeoutMs: number }).timeoutMs).toBe(30_000);
  });

  it("keeps the user's own ssh command but still forces BatchMode", async () => {
    const runGit = vi.fn(async (_args: ReadonlyArray<string>) => ({ code: 0, stderr: "" }));
    await routeSelectedFetch(
      {
        operands: { cwd: "/repo", remoteName: "origin", refspecs: [], timeoutMs: 5_000 },
        owner: undefined,
        targets: async () => [{ hosts: ["github.com"], user: "dev" }],
      },
      new AbortController().signal,
      {
        resolveRemoteUrl: async () => "git@github.com:o/r.git",
        readGitConfig: async () => "ssh -i /k/work",
        runGit,
      },
    );
    expect(runGit.mock.calls[0]![0].slice(0, 2)).toEqual([
      "-c",
      "core.sshCommand=ssh -i /k/work -o BatchMode=yes",
    ]);
  });

  it("backs off background refresh after an owner refusal instead of retrying every poll", async () => {
    const repo = join(root, "repo");
    git(root, "init", "-q", "-b", "main", repo);
    git(repo, "remote", "add", "origin", "ssh://u@target.example/srv/x.git");
    const ok: ExecuteGitResult = {
      code: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    const execute = (input: ExecuteGitInput): Effect.Effect<ExecuteGitResult> => {
      const args = input.args;
      if (args[0] === "status") {
        return Effect.succeed({
          ...ok,
          stdout: "# branch.head main\n# branch.upstream origin/main\n",
        });
      }
      if (args[0] === "remote" && args[1] === "get-url")
        return Effect.succeed({ ...ok, stdout: "ssh://u@target.example/srv/x.git\n" });
      if (args[0] === "remote") return Effect.succeed({ ...ok, stdout: "origin\n" });
      if (args.includes("@{upstream}")) return Effect.succeed({ ...ok, stdout: "origin/main\n" });
      if (args.includes("--git-common-dir"))
        return Effect.succeed({ ...ok, stdout: `${repo}/.git\n` });
      return Effect.succeed({ ...ok, code: args[0] === "rev-parse" ? 1 : 0 });
    };
    const owner = {
      fetch: vi.fn(async (operands: { cwd: string }) => {
        throw initiatingTransportUnavailable("fetch", operands.cwd);
      }),
    };
    const projects = {
      listAll: () =>
        Effect.succeed([{ executionTargetId: "ssh:host=target.example&user=u", deletedAt: null }]),
    } as unknown as ProjectionProjectRepositoryShape;
    await Effect.runPromise(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const ops = yield* makeGitStatusOps(makeGitHelpers(execute), path, "initiating");
        for (let poll = 0; poll < 3; poll += 1) yield* ops.statusDetails(repo);
      }).pipe(
        Effect.provideService(InitiatingFetchOwner, owner),
        Effect.provideService(ProjectionProjectRepository, projects),
        Effect.provide(Path.layer),
      ),
    );
    expect(owner.fetch).toHaveBeenCalledTimes(1);
  });
});

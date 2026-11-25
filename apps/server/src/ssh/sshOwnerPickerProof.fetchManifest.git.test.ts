import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";

import {
  approve,
  live,
  signal,
  withFixture,
  withOwner,
} from "./sshOwnerPickerProof.scopedNative.fixture.ts";
import type { LaunchedPickerProofOwner } from "./sshOwnerPickerProof.client.ts";

const exec = promisify(execFile);
const gitEnv = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
const contents = "bigbud scoped fetch fixture\n";
const expectedCommit = "9ec7dd5a0eac6c3574466234c87edb5f59dda27b";
const branch = "refs/heads/main";
const fetchedRef = "refs/remotes/proof/main";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function git(
  cwd: string,
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
) {
  const env = { ...gitEnv, ...options.env };
  if (options.input === undefined) {
    return (await exec("/usr/bin/git", args, { cwd, env, timeout: 15_000 })).stdout;
  }
  const child = spawn("/usr/bin/git", args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(5_000),
  });
  const output = Promise.all([text(child.stdout), text(child.stderr), once(child, "close")]);
  child.stdin.on("error", () => child.kill());
  child.stdin.end(options.input);
  const [stdout, stderr, [code]] = await output;
  if (code !== 0) throw new Error(`Git fixture plumbing failed: ${stderr}`);
  return stdout;
}

async function initBare(root: string, name: string) {
  await git(root, [
    "init",
    "--bare",
    "--template=",
    "--initial-branch=main",
    "--object-format=sha1",
    name,
  ]);
  return path.join(root, name);
}

async function seed(repo: string) {
  const blob = (await git(repo, ["hash-object", "-w", "--stdin"], { input: contents })).trim();
  const tree = (await git(repo, ["mktree"], { input: `100644 blob ${blob}\tproof.txt\n` })).trim();
  const who = "Fixture <fixture@example.invalid> 1700000000 +0000";
  const commit = (
    await git(repo, ["hash-object", "-w", "-t", "commit", "--stdin"], {
      input: `tree ${tree}\nauthor ${who}\ncommitter ${who}\n\nseed scoped fetch fixture\n`,
    })
  ).trim();
  expect(commit).toBe(expectedCommit);
  await git(repo, ["update-ref", branch, commit]);
  return blob;
}

async function snapshot(root: string): Promise<unknown> {
  const info = await lstat(root);
  return [
    info.mode,
    info.isDirectory()
      ? await Promise.all(
          (await readdir(root))
            .toSorted()
            .map(async (name) => [name, await snapshot(path.join(root, name))]),
        )
      : await readFile(root),
  ];
}

type UploadLease = Awaited<ReturnType<LaunchedPickerProofOwner["openGitUpload"]>>;

// Fixture-only shim: Git performs its real SSH transport negotiation and pack
// handling, but its local transport subprocess can only reach the already-open
// owner lease via this private socket. It never dials the placeholder Git host.
async function fetchOverLease(root: string, client: string, { pipes, exit }: UploadLease) {
  const socketPath = path.join(root, "git-fetch.sock");
  const shim = path.join(root, "git-lease.cjs");
  const trace = path.join(root, "git-fetch.trace");
  await writeFile(
    shim,
    `
const { connect } = require('node:net');
const socket = connect(process.env.BIGBUD_GIT_TEST_SOCKET);
socket.on('error', (error) => { console.error(error.message); process.exit(1); });
socket.on('end', () => process.stdin.pause());
process.stdin.pipe(socket);
socket.pipe(process.stdout);
`,
    { mode: 0o600 },
  );
  const server = createServer({ allowHalfOpen: true });
  const listen = once(server, "listening");
  server.listen(socketPath);
  await listen;
  const stderr = text(pipes.stderr);
  const sockets = new Set<Socket>();
  let connections = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => pipes.stdin.destroy(error));
    if (++connections !== 1) {
      socket.destroy();
      return;
    }
    socket.pipe(pipes.stdin);
    pipes.stdout.pipe(socket);
  });
  try {
    await git(
      client,
      [
        "-c",
        "protocol.version=2",
        "-c",
        "fetch.unpackLimit=1",
        "fetch",
        "--no-tags",
        "--no-auto-maintenance",
        "--no-write-fetch-head",
        "ssh://git@fixture.invalid/upload.git",
        `${branch}:${fetchedRef}`,
      ],
      {
        env: {
          GIT_SSH_COMMAND: `${quote(process.execPath)} ${quote(shim)}`,
          GIT_SSH_VARIANT: "ssh",
          GIT_TRACE_PACKET: trace,
          BIGBUD_GIT_TEST_SOCKET: socketPath,
        },
      },
    );
    expect(connections).toBe(1);
    const packets = await readFile(trace, "utf8");
    expect(packets).toMatch(/fetch< version 2/);
    expect(packets).toMatch(/fetch> command=fetch/);
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    await expect(stderr).resolves.toBe("");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it.skipIf(!live)(
  "fetches a verified nonempty pack through the startup-bound native upload-pack lease",
  () =>
    withFixture(async (fixture) => {
      const repositoryPath = await initBare(fixture.root, "upload.git");
      const blob = await seed(repositoryPath);
      const before = await snapshot(repositoryPath);
      const client = await initBare(fixture.root, "client.git");
      await expect(git(client, ["cat-file", "-e", expectedCommit])).rejects.toThrow();
      await withOwner(
        fixture,
        { gitUploadFixture: { repositoryPath } },
        async (owner, executionTargetId) => {
          await approve(owner);
          await expect(
            owner.openGitUpload(
              {
                executionTargetId,
                repositoryPath: "/tmp/bigbud-picker-linux-Other/upload.git",
              },
              signal(),
            ),
          ).rejects.toMatchObject({ code: "operationDenied" });
          await expect(
            owner.openGitAdvertisement(
              {
                executionTargetId,
                repositoryPath,
                sourceRef: branch,
                destinationRef: branch,
                sourceOid: expectedCommit,
              },
              signal(),
            ),
          ).rejects.toMatchObject({ code: "operationDenied" });
          const lease = await owner.openGitUpload({ executionTargetId, repositoryPath }, signal());
          await fetchOverLease(fixture.root, client, lease);
        },
      );
      expect(await snapshot(repositoryPath)).toEqual(before);
      expect(await git(client, ["rev-parse", fetchedRef])).toBe(`${expectedCommit}\n`);
      expect(await git(client, ["cat-file", "blob", `${fetchedRef}:proof.txt`])).toBe(contents);
      expect(await git(client, ["fsck", "--strict", "--no-reflogs"])).toBe("");
      const packFiles = await readdir(path.join(client, "objects/pack"));
      const indexes = packFiles.filter((name) => /^pack-[0-9a-f]{40}\.idx$/.test(name));
      expect(indexes).toHaveLength(1);
      const verified = await git(client, ["verify-pack", "-v", `objects/pack/${indexes[0]}`]);
      expect(verified.match(/^[0-9a-f]{40} /gm)).toHaveLength(3);
      expect(verified).toContain(`${expectedCommit} commit `);
      expect(verified).toContain(`${blob} blob `);
    }),
  60_000,
);

it.skipIf(!live).each(["extra ref", "mismatched object"] as const)(
  "refuses a nonempty repository before advertising Git capabilities (%s)",
  (mutation) =>
    withFixture(async (fixture) => {
      const repositoryPath = await initBare(fixture.root, "upload.git");
      const blob = await seed(repositoryPath);
      if (mutation === "extra ref") {
        await git(repositoryPath, ["update-ref", "refs/heads/extra", expectedCommit]);
      } else {
        const loose = path.join(repositoryPath, "objects", blob.slice(0, 2), blob.slice(2));
        await unlink(loose);
        await writeFile(loose, deflateSync("blob 5\0wrong"), { mode: 0o400 });
      }
      const before = await snapshot(repositoryPath);
      await withOwner(
        fixture,
        { gitUploadFixture: { repositoryPath } },
        async (owner, executionTargetId) => {
          await approve(owner);
          const lease = await owner.openGitUpload({ executionTargetId, repositoryPath }, signal());
          lease.pipes.stdin.end();
          await expect(text(lease.pipes.stdout)).resolves.toBe("");
          await expect(lease.exit).resolves.toEqual({ code: 126, signal: null });
        },
      );
      expect(await snapshot(repositoryPath)).toEqual(before);
    }),
  60_000,
);

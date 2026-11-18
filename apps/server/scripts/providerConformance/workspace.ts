/**
 * Disposable workspace and cleanup journal for the provider conformance harness (WP-5D).
 *
 * Everything the harness creates is named `bigbud-conformance-*`: one work directory holding
 * the project folder (on the backend host) and, locally, `restore-journal.json`. The journal is
 * written before each project/thread is created, so `--restore <workDir>` can always replay
 * cleanup. The harness changes no provider settings, so there is nothing else to restore.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { SSH_OPTIONS } from "./client.ts";

export const CONFORMANCE_PREFIX = "bigbud-conformance";
export const WORK_DIR_PREFIX = `${CONFORMANCE_PREFIX}-work-`;

/** Files in the disposable project folder, written once on the backend host. */
export interface Workspace {
  /** Absolute project folder on the backend host. */
  readonly projectRoot: string;
  readonly writeFile: (relativePath: string, contents: string) => Promise<void>;
  /** Remove the whole work directory (only when cleanup fully succeeded). */
  readonly remove: () => Promise<void>;
}

export type WorkspaceLocation =
  | { readonly kind: "local"; readonly workDir: string }
  | { readonly kind: "ssh"; readonly sshTarget: string; readonly remoteWorkDir: string }
  | { readonly kind: "mock"; readonly workDir: string };

export interface RestoreJournal {
  readonly tool: "providerConformance";
  readonly createdAt: string;
  readonly location: WorkspaceLocation;
  readonly projectId: string | null;
  readonly threadIds: ReadonlyArray<string>;
}

export function assertDisposableDir(path: string): void {
  if (!path.startsWith("/") || !basename(path).startsWith(WORK_DIR_PREFIX))
    throw new Error(`Refusing to use ${basename(path)}: not a ${WORK_DIR_PREFIX}* directory.`);
}

export const journalPath = (localWorkDir: string) => join(localWorkDir, "restore-journal.json");

export function writeJournal(localWorkDir: string, journal: RestoreJournal): void {
  writeFileSync(journalPath(localWorkDir), `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function readJournal(localWorkDir: string): RestoreJournal {
  const journal = JSON.parse(readFileSync(journalPath(localWorkDir), "utf8")) as RestoreJournal;
  if (journal.tool !== "providerConformance") throw new Error("Not a conformance journal.");
  return journal;
}

/** Journal updates are appended in memory and flushed before each backend mutation. */
export function makeJournal(localWorkDir: string, initial: RestoreJournal) {
  let current = initial;
  writeJournal(localWorkDir, current);
  return {
    get: () => current,
    setProject: (projectId: string) => {
      current = { ...current, projectId };
      writeJournal(localWorkDir, current);
    },
    addThread: (threadId: string) => {
      current = { ...current, threadIds: [...current.threadIds, threadId] };
      writeJournal(localWorkDir, current);
    },
  };
}
export type Journal = ReturnType<typeof makeJournal>;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Run one POSIX script on the host over SSH; resolves with stdout. Stderr is discarded. */
export function sshExec(target: string, script: string, stdin = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTIONS, target, "--", `sh -c ${quote(script)}`], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ssh step exited ${code}`)),
    );
    child.stdin.end(stdin);
  });
}

function safeRelative(relativePath: string): string {
  if (relativePath.startsWith("/") || relativePath.split("/").includes(".."))
    throw new Error("Workspace paths must stay inside the project folder.");
  return relativePath;
}

export function localWorkspace(workDir: string): Workspace {
  assertDisposableDir(workDir);
  const projectRoot = join(workDir, "project");
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  return {
    projectRoot,
    writeFile: async (relativePath, contents) =>
      writeFileSync(join(projectRoot, safeRelative(relativePath)), contents, { mode: 0o600 }),
    remove: async () => rmSync(workDir, { recursive: true, force: true }),
  };
}

/** Create `$HOME/bigbud-conformance-work-<stamp>/project` on the host and return its path. */
export async function createRemoteWorkDir(target: string, stamp: string): Promise<string> {
  const name = `${WORK_DIR_PREFIX}${stamp}`;
  const path = (
    await sshExec(target, `umask 077; d="$HOME/${name}"; mkdir -p "$d/project" && printf %s "$d"`)
  ).trim();
  assertDisposableDir(path);
  return path;
}

export function sshWorkspace(target: string, remoteWorkDir: string): Workspace {
  assertDisposableDir(remoteWorkDir);
  const projectRoot = `${remoteWorkDir}/project`;
  return {
    projectRoot,
    writeFile: async (relativePath, contents) => {
      await sshExec(
        target,
        `umask 077; cat > ${quote(`${projectRoot}/${safeRelative(relativePath)}`)}`,
        contents,
      );
    },
    remove: async () => {
      await sshExec(target, `rm -rf -- ${quote(remoteWorkDir)}`);
    },
  };
}

export function workspaceFor(location: WorkspaceLocation): Workspace {
  if (location.kind === "local") return localWorkspace(location.workDir);
  if (location.kind === "ssh") return sshWorkspace(location.sshTarget, location.remoteWorkDir);
  throw new Error("The mock workspace is created by the mock backend.");
}

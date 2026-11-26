import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { findWorkspaceAgentTarget } from "../../../../scripts/lib/workspace-agent-target.ts";
import type { SshOwnerArtifact } from "./sshOwnerProductionArtifact.ts";
import type { SshOwnerProductionProfile } from "./sshOwnerProductionClient.launch.ts";
import {
  pidAlive,
  writeFakeSshOwnerBinary,
  type FakeOwnerMode,
  type FakeOwnerObservation,
} from "./sshOwnerProductionClient.fakeOwner.ts";

/**
 * Shared disposable fixture for the production-client tests. No SSH endpoint is
 * contacted; the fake owner only speaks the v1 frame handshake.
 *
 * @module sshOwnerProductionClient.fixture
 */

const target = findWorkspaceAgentTarget(process.platform, process.arch)!;

export interface ProductionFixture {
  readonly root: string;
  readonly stateDirectory: string;
  readonly observationFile: string;
  readonly profile: SshOwnerProductionProfile;
  readonly activityFile: string;
  artifact(path: string, profile?: SshOwnerArtifact["profile"]): SshOwnerArtifact;
  fakeOwner(
    mode: FakeOwnerMode,
    options?: {
      readonly aliasDescriptor?: Buffer;
      readonly rejectTarget?: string;
    },
  ): Promise<string>;
  observation(): Promise<FakeOwnerObservation>;
  exists(path: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export async function makeProductionFixture(): Promise<ProductionFixture> {
  // A private Unix socket path must stay under the platform byte limit.
  const base = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  const root = await mkdtemp(join(await realpath(base), "bigbud-oc-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  const observationFile = join(root, "observation.json");
  const activityFile = join(root, "activity.log");
  return {
    root,
    stateDirectory,
    observationFile,
    activityFile,
    profile: {
      stateDirectory,
      target: {
        targetId: "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
        kind: "structured",
        host: "127.0.0.1",
        port: 2_222,
        user: "tester",
        identityFile: join(root, "id_ed25519"),
        knownHostsFile: join(root, "known_hosts"),
      },
    },
    artifact: (path, profile = "desktop-dev") => ({
      profile,
      path,
      target,
      evidence: "header",
    }),
    fakeOwner: (mode, options = {}) =>
      writeFakeSshOwnerBinary(root, {
        mode,
        observationFile,
        activityFile,
        ...(options.aliasDescriptor === undefined
          ? {}
          : { aliasDescriptor: options.aliasDescriptor }),
        ...(options.rejectTarget === undefined ? {} : { rejectTarget: options.rejectTarget }),
      }),
    observation: async () =>
      JSON.parse(await readFile(observationFile, "utf8")) as FakeOwnerObservation,
    exists: (path) =>
      lstat(path).then(
        () => true,
        () => false,
      ),
    dispose: async () => {
      await reapOwnersUnder(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Bounded reap of every process whose command line names this fixture root (an
 * owner started with `--state-dir <root>/state`). A run that ended before its
 * handle shut down (a failed or interrupted test) must not leave an owner serving
 * an attach socket under a directory that is about to be removed.
 */
export async function reapOwnersUnder(root: string, timeoutMs = 3_000): Promise<number[]> {
  const list = () => {
    try {
      return execFileSync("pgrep", ["-f", "--", `--state-dir ${root}/`], { encoding: "utf8" })
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    } catch {
      return [];
    }
  };
  const found = list();
  for (const pid of found) killIfAlive(pid);
  const deadline = Date.now() + timeoutMs;
  while (found.some(pidAlive) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return found;
}

export function newCapability() {
  return randomBytes(32);
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for the disposable owner fixture.");
}

export const waitForDeath = (pid: number) => waitFor(() => !pidAlive(pid));

export function killIfAlive(pid: number): void {
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

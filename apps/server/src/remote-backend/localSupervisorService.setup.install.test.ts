import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RemoteAgentInstallResult } from "../remote-agent/remoteAgentInstallManager.ts";
import { emptyRemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { remoteAgentRuntimeSummary } from "../remote-agent/remoteAgentStatus.ts";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import { localSupervisorServiceSetupDependencies } from "./localSupervisorService.setup.runtime.ts";
import { verifyManagedLocalSupervisor } from "./localSupervisorBinary.ts";

const staged = vi.hoisted(() => ({ result: undefined as RemoteAgentInstallResult | undefined }));
// Only the already-successful artifact stager is controlled. The real default post-install
// operation and strict filesystem verifier run; this does not qualify a native handshake.
vi.mock("./localSupervisorInstaller.ts", async (original) => ({
  ...(await original<typeof import("./localSupervisorInstaller.ts")>()),
  makeLocalSupervisorInstaller: () => ({
    install: async () => {
      if (!staged.result) throw new Error("Staged fixture required.");
      return staged.result;
    },
  }),
}));
const directories: string[] = [];
afterEach(async () => {
  staged.result = undefined;
  for (const path of directories.splice(0)) await fs.rm(path, { recursive: true, force: true });
});
async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp("/tmp/bbs-"));
  directories.push(home);
  const root = join(home, ".bigbud/agent"),
    bytes = Buffer.from("controlled-staged-artifact\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact: RemoteAgentInstallResult["artifact"] = {
    version: "1-fixture",
    buildDigest: "fixture-build",
    protocolMajor: 1,
    protocolMinor: 0,
    targetTriple: "aarch64-unknown-linux-gnu",
    sizeBytes: bytes.length,
    sha256,
    url: "https://fixture.invalid/artifact",
    signature: { algorithm: "ed25519", keyId: "fixture", value: "A".repeat(88) },
  };
  const binaryPath = join(root, "bin", artifact.version, sha256, "bigbud-remote-agent");
  for (const path of [
    join(home, ".bigbud"),
    root,
    join(root, "bin"),
    join(root, "bin", artifact.version),
    join(root, "bin", artifact.version, sha256),
  ])
    await fs.mkdir(path, { mode: 0o700 });
  await fs.writeFile(binaryPath, bytes, { mode: 0o700 });
  const statePath = join(root, "runtimes", `g-${sha256.slice(0, 24)}`);
  const runtime: RemoteAgentRuntime = {
    generation: `g-${sha256.slice(0, 24)}`,
    version: artifact.version,
    sha256,
    buildDigest: artifact.buildDigest,
    targetTriple: artifact.targetTriple,
    origin: "managed",
    binaryPath,
    statePath,
    socketPath: join(statePath, "supervisor.sock"),
    logPath: join(statePath, "supervisor.log"),
  };
  const registry = {
    ...emptyRemoteAgentRegistry(),
    builds: [
      {
        id: `${artifact.version}:${sha256}:${artifact.targetTriple}`,
        authenticated: true,
        binary: "present" as const,
        health: "staged" as const,
        promotion: 0,
        runtime,
      },
    ],
  };
  const paths = {
    root,
    binRoot: join(root, "bin"),
    stateRoot: join(root, "state"),
    versionRoot: join(root, "bin", artifact.version),
    buildRoot: join(root, "bin", artifact.version, sha256),
    installedBinary: binaryPath,
    activeLink: join(root, "bin/current"),
    previousLink: join(root, "bin/previous"),
  };
  staged.result = {
    artifact,
    paths,
    binaryPath,
    status: "staged",
    placement: "upload",
    inboxConflict: false,
    targetTriple: artifact.targetTriple,
    platform: {
      operatingSystem: "linux",
      architecture: "aarch64",
      targetTriple: artifact.targetTriple,
    },
    runtimeSummary: remoteAgentRuntimeSummary(registry),
  };
  const commands: string[] = [];
  const control: LocalSupervisorControl = {
    root,
    homeDir: home,
    targetId: `remote-backend:${"a".repeat(32)}`,
    openControl: async () => ({
      root,
      run: async () => {
        throw new Error("Unexpected registry mutation");
      },
      registry: {
        read: async () => registry,
        update: async () => {
          throw new Error("Unexpected registry mutation");
        },
      },
    }),
    run: async (_target, command) => {
      commands.push(command);
      return {
        stdout: "backend-service=2 backend-service-graph=1",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    },
  };
  const install = () =>
    localSupervisorServiceSetupDependencies.install(
      control,
      { manifest: { schemaVersion: 1, artifacts: [artifact] }, trustStore: {} },
      new AbortController().signal,
    );
  return { root, runtime, binaryPath, commands, install };
}

it("default post-install provisions the exact missing managed generation before strict verification", async () => {
  const f = await fixture();
  await expect(verifyManagedLocalSupervisor(f.runtime)).rejects.toHaveProperty("code", "ENOENT");
  expect(await f.install()).toEqual(f.runtime);
  await expect(verifyManagedLocalSupervisor(f.runtime)).resolves.toBeUndefined();
  for (const path of [join(f.root, "runtimes"), f.runtime.statePath]) {
    const stat = await fs.lstat(path);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o7777).toBe(0o700);
    expect(stat.uid).toBe(process.getuid!());
    expect(await fs.readdir(path)).toEqual(
      path === f.runtime.statePath ? [] : [f.runtime.generation],
    );
  }
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]).toContain("--check --capabilities");
});

it("refuses changed installed bytes before creating generation state", async () => {
  const f = await fixture();
  await fs.writeFile(f.binaryPath, "changed");
  await expect(f.install()).rejects.toThrow();
  await expect(fs.lstat(join(f.root, "runtimes"))).rejects.toHaveProperty("code", "ENOENT");
  expect(f.commands).toEqual([]);
});

it.each(["symlink", "unsafe-mode"])("preserves an existing %s runtime parent", async (kind) => {
  const f = await fixture(),
    parent = join(f.root, "runtimes"),
    foreign = join(f.root, "foreign");
  await fs.mkdir(foreign, { mode: 0o700 });
  await fs.writeFile(join(foreign, "keep"), "foreign");
  if (kind === "symlink") await fs.symlink(foreign, parent);
  else {
    await fs.mkdir(parent, { mode: 0o700 });
    await fs.chmod(parent, 0o755);
  }
  const before = await fs.lstat(parent);
  await expect(f.install()).rejects.toThrow();
  expect((await fs.lstat(parent)).ino).toBe(before.ino);
  expect((await fs.lstat(parent)).mode).toBe(before.mode);
  expect(await fs.readFile(join(foreign, "keep"), "utf8")).toBe("foreign");
  await expect(fs.lstat(f.runtime.statePath)).rejects.toHaveProperty("code", "ENOENT");
  expect(f.commands).toEqual([]);
});

it("refuses a preexisting generation containing foreign state without deleting or adopting it", async () => {
  const f = await fixture();
  await fs.mkdir(join(f.root, "runtimes"), { mode: 0o700 });
  await fs.mkdir(f.runtime.statePath, { mode: 0o700 });
  const foreign = join(f.runtime.statePath, "foreign-state");
  await fs.writeFile(foreign, "keep", { mode: 0o600 });
  const before = await fs.lstat(f.runtime.statePath);
  await expect(f.install()).rejects.toThrow("must be empty");
  expect(await fs.readFile(foreign, "utf8")).toBe("keep");
  expect((await fs.lstat(f.runtime.statePath)).ino).toBe(before.ino);
  expect(f.commands).toEqual([]);
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeSqlitePersistenceLive } from "../../../persistence/Layers/Sqlite.ts";
import type { PickerProofBoundTarget } from "../../../ssh/sshOwnerPickerProof.client.session.types.ts";
import type { ProofOpencodeState } from "../../../ssh/sshOwnerPickerProof.codec.opencode.ts";
import {
  resolveSshOwnerLaunchFacts,
  type SshOwnerTargetDescriptor,
} from "../../../ssh/sshOwnerProductionClient.launch.ts";
import {
  startOrAttachSshOwnerProduction,
  type SshOwnerProductionHandle,
} from "../../../ssh/sshOwnerProductionClient.ts";
import { makeProductionFixture } from "../../../ssh/sshOwnerProductionClient.fixture.ts";
import type { OpencodeV2ServiceBinding } from "../../../ssh/sshOwnerRemotePath.ts";
import { resolveProductionTargetDescriptor } from "../../../ssh/sshOwnerProductionTargets.ts";

/**
 * Live fixture for the PRODUCTION (target-free) owner's OpenCode v2 lane: the
 * real `bigbud-ssh-owner --production`, one or more disposable loopback sshd
 * targets with generated keys, and the real OpenCode v2 CLI on the "remote".
 *
 * Run only in a fresh loopback-only network namespace on a disposable host.
 *
 * @module ServerManager.sshOwner.production.native.fixture
 */

export interface LiveTarget {
  readonly descriptor: SshOwnerTargetDescriptor;
  readonly cwd: string;
  readonly commandStarts: () => Promise<number>;
}

export interface ProductionV2Live {
  readonly handle: SshOwnerProductionHandle;
  readonly binaryPath: string;
  readonly targets: ReadonlyArray<LiveTarget>;
}

function assertLoopbackOnly() {
  const interfaces = Object.entries(networkInterfaces());
  if (interfaces.length !== 1 || interfaces[0]?.[0] !== "lo")
    throw new Error("Run the production OpenCode v2 proof in a loopback-only network namespace.");
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("port")),
      );
    });
  });
}

async function startSshd(root: string, index: number, children: ChildProcess[]) {
  const dir = path.join(root, `target-${index}`);
  await mkdir(dir, { mode: 0o700 });
  const keygen = (file: string) =>
    execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
  keygen(path.join(dir, "host_key"));
  keygen(path.join(dir, "identity"));
  await writeFile(
    path.join(dir, "authorized_keys"),
    await readFile(path.join(dir, "identity.pub"), "utf8"),
    { mode: 0o600 },
  );
  const port = await freePort();
  await writeFile(
    path.join(dir, "sshd_config"),
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${path.join(dir, "host_key")}`,
      `AuthorizedKeysFile ${path.join(dir, "authorized_keys")}`,
      `PidFile ${path.join(dir, "sshd.pid")}`,
      "UsePAM no",
      "StrictModes no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "AllowTcpForwarding local",
      "PermitOpen 127.0.0.1:*",
      "AllowStreamLocalForwarding no",
      "PermitTTY no",
      "LogLevel VERBOSE",
      "",
    ].join("\n"),
  );
  const child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", path.join(dir, "sshd_config")], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let text = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    // Kept in memory: a file write could outlive the fixture's disposal.
    text += chunk.toString("utf8");
  });
  const deadline = Date.now() + 5_000;
  while (!text.includes(`Server listening on 127.0.0.1 port ${port}`)) {
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error(`Disposable sshd did not bind:\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const [keyType, key] = (await readFile(path.join(dir, "host_key.pub"), "utf8")).split(" ");
  await writeFile(path.join(dir, "known_hosts"), `[127.0.0.1]:${port} ${keyType} ${key}\n`, {
    mode: 0o600,
  });
  const cwd = path.join(dir, "work");
  await mkdir(cwd, { mode: 0o700 });
  const user = execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();
  return {
    descriptor: {
      targetId: `ssh:${new URLSearchParams({ host: "127.0.0.1", port: String(port), user, transport: "direct-ssh" })}`,
      kind: "structured",
      host: "127.0.0.1",
      port,
      user,
      authMode: "key",
      identityFile: path.join(dir, "identity"),
      knownHostsFile: path.join(dir, "known_hosts"),
    },
    cwd,
    commandStarts: async () => [...text.matchAll(/Starting session: command\b/g)].length,
  } satisfies LiveTarget;
}

/**
 * An already-running disposable Linux sshd reached from this host (for example
 * a macOS initiator against a disposable VM). The remote binary and cwd are
 * paths on that host; no command count is observable from here.
 */
export interface ExternalV2Target {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
  readonly cwd: string;
  readonly remoteBinary: string;
}

export function readExternalV2Target(value: string | undefined): ExternalV2Target | undefined {
  return value === undefined ? undefined : (JSON.parse(value) as ExternalV2Target);
}

export interface ProductionV2Options {
  /** Owner binding; default: the copied executable as an explicit override. */
  readonly binding?: OpencodeV2ServiceBinding;
  /** Present target 0 as an `~/.ssh/config`-style alias resolved by the owner. */
  readonly aliasFirstTarget?: boolean;
  /**
   * W2 T-alias: write that alias the way a real user config does: declared in
   * an ordered `Include config.d/*.conf`, two names on one `Host` line, `Host *`
   * defaults after it, the key under `~/.ssh/keys/` and no `Port` when it is 22.
   */
  readonly userProfileLayout?: boolean;
}

export const LIVE_ALIAS = "bb-oc-alias";

/**
 * Presents the target as a `~/.ssh/config` alias resolved by the production
 * descriptor resolver. The key and pin are copied into a real `~/.ssh` reached
 * through a symlinked home (as macOS `/tmp` and `/var` are links), so the
 * descriptor must use the owner's canonical config scope.
 */
async function asAlias(
  root: string,
  target: LiveTarget,
  userProfile = false,
): Promise<{ target: LiveTarget; config: string }> {
  const { descriptor } = target;
  const real = path.join(root, "alias-home-real");
  await mkdir(path.join(real, ".ssh"), { recursive: true, mode: 0o700 });
  const home = path.join(root, "alias-home");
  await symlink(real, home);
  const identityFile = path.join(home, ".ssh", "identity");
  const knownHostsFile = path.join(home, ".ssh", "known_hosts");
  await copyFile(descriptor.identityFile, identityFile);
  await copyFile(descriptor.knownHostsFile, knownHostsFile);
  const config = path.join(home, ".ssh", "config");
  if (userProfile) {
    await mkdir(path.join(real, ".ssh", "keys"), { mode: 0o700 });
    await mkdir(path.join(real, ".ssh", "config.d"), { mode: 0o700 });
    const key = path.join(home, ".ssh", "keys", "work_ed25519");
    await copyFile(descriptor.identityFile, key);
    await writeFile(
      path.join(real, ".ssh", "config.d", "10-work.conf"),
      [
        `Host ${LIVE_ALIAS} ${LIVE_ALIAS}-second`,
        `  HostName ${descriptor.host}`,
        ...(descriptor.port === 22 ? [] : [`  Port ${descriptor.port}`]),
        `  User ${descriptor.user}`,
        "  IdentityFile ~/.ssh/keys/work_ed25519",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      config,
      [
        "# personal defaults",
        "Include config.d/*.conf",
        "",
        "Host *",
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${knownHostsFile}`,
        "  ServerAliveInterval 30",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const resolved = await resolveProductionTargetDescriptor(`ssh:${LIVE_ALIAS}`, { home });
    return { target: { ...target, descriptor: resolved }, config };
  }
  await writeFile(
    config,
    [
      `Host ${LIVE_ALIAS}`,
      `  HostName ${descriptor.host}`,
      `  Port ${descriptor.port}`,
      `  User ${descriptor.user}`,
      `  IdentityFile ${identityFile}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${knownHostsFile}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const resolved = await resolveProductionTargetDescriptor(`ssh:${LIVE_ALIAS}`, { home });
  return { target: { ...target, descriptor: resolved }, config };
}

export async function withProductionV2Owner<A>(
  executable: string | ExternalV2Target,
  targetCount: number,
  run: (live: ProductionV2Live) => Promise<A>,
  options: ProductionV2Options = {},
): Promise<A> {
  if (typeof executable === "string") assertLoopbackOnly();
  const fixture = await makeProductionFixture();
  const children: ChildProcess[] = [];
  try {
    const targets: LiveTarget[] = [];
    let binaryPath: string;
    let aliasConfig: string | undefined;
    if (typeof executable === "string") {
      binaryPath = path.join(fixture.root, "opencode");
      await copyFile(executable, binaryPath);
      await chmod(binaryPath, 0o500);
      for (let index = 0; index < targetCount; index += 1)
        targets.push(await startSshd(fixture.root, index, children));
    } else {
      binaryPath = executable.remoteBinary;
      targets.push({
        descriptor: {
          targetId: `ssh:${new URLSearchParams({ host: executable.host, port: String(executable.port), user: executable.user, transport: "direct-ssh" })}`,
          kind: "structured",
          host: executable.host,
          port: executable.port,
          user: executable.user,
          authMode: "key",
          identityFile: executable.identityFile,
          knownHostsFile: executable.knownHostsFile,
        },
        cwd: executable.cwd,
        commandStarts: async () => -1,
      });
    }
    if (options.aliasFirstTarget) {
      const alias = await asAlias(fixture.root, targets[0]!, options.userProfileLayout);
      targets[0] = alias.target;
      aliasConfig = alias.config;
    }
    const owner = fileURLToPath(
      new URL("../../../../../../target/debug/bigbud-ssh-owner", import.meta.url),
    );
    const facts = resolveSshOwnerLaunchFacts({
      stateDirectory: fixture.stateDirectory,
      opencodeV2Service: options.binding ?? { binaryPath },
      ...(aliasConfig === undefined ? {} : { aliasConfig }),
    });
    const layer = makeSqlitePersistenceLive(path.join(fixture.root, "state.sqlite"), {
      worker: false,
    }).pipe(Layer.provide(NodeServices.layer));
    return await Effect.runPromise(
      Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
        Effect.gen(function* () {
          const handle = yield* startOrAttachSshOwnerProduction({
            artifact: fixture.artifact(owner),
            facts,
            sql,
          });
          return yield* Effect.promise(() => run({ handle, binaryPath, targets })).pipe(
            Effect.ensuring(handle.shutdown()),
          );
        }),
      ).pipe(Effect.provide(layer)),
    );
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await fixture.dispose();
  }
}

export const refused = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1_000, () => socket.destroy(new Error("probe timed out")));
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
  });

export const info = (port: number, password?: string) =>
  fetch(`http://127.0.0.1:${port}/api/info`, {
    ...(password === undefined
      ? {}
      : {
          headers: {
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          },
        }),
    signal: AbortSignal.timeout(2_000),
  });

/** Records each target's owner states without changing what the owner sees. */
export function recording(bound: PickerProofBoundTarget, states: ProofOpencodeState[]) {
  const record = (state: ProofOpencodeState) => {
    states.push(state);
    return state;
  };
  return Object.assign(Object.create(bound) as PickerProofBoundTarget, {
    openOpencodeV2: async (...args: Parameters<PickerProofBoundTarget["openOpencodeV2"]>) =>
      record(await bound.openOpencodeV2(...args)),
    opencodeV2Status: async (...args: Parameters<PickerProofBoundTarget["opencodeV2Status"]>) =>
      record(await bound.opencodeV2Status(...args)),
  });
}

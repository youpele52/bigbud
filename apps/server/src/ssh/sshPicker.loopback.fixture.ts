import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { userInfo } from "node:os";
import path from "node:path";

import { prepareAuthenticationGate } from "./sshPicker.loopback.fixture.authGate.ts";
import { prepareInteractiveCommand } from "./sshPicker.loopback.fixture.interactive.ts";

type Loopback = "127.0.0.1" | "::1";
const sandbox = "/usr/bin/sandbox-exec";
const ssh = "/usr/bin/ssh";
const sshd = "/usr/sbin/sshd";
const sshKeygen = "/usr/bin/ssh-keygen";

async function reserveLoopbackPort(loopback: Loopback): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, loopback, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForListener(child: ChildProcess, loopback: Loopback, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Wait for this child, not for whatever might have won the port allocation race.
    const ready = `Server listening on ${loopback} port ${port}.`;
    let output = "";
    const timer = setTimeout(() => finish(new Error(`sshd readiness timed out: ${output}`)), 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("error", finish);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`Fixture sshd exited before binding (${code ?? signal}): ${output}`));
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4096);
      if (output.includes(ready)) finish();
    };
    child.stderr?.on("data", onData);
    child.once("error", finish);
    child.once("exit", onExit);
  });
}

function sandboxPolicy(ambientHomes: string[], port?: number): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    ...(port === undefined ? [] : [`(allow network-outbound (remote ip "localhost:${port}"))`]),
    '(deny file-read* (literal "/private/etc/profile"))',
    ...[...ambientHomes, "/etc/ssh", "/private/etc/ssh"].map(
      (dir) => `(deny file-read* file-write* (subpath ${JSON.stringify(dir)}))`,
    ),
  ].join("\n");
}

// Apple's sshd installs its own pre-auth sandbox and cannot start inside sandbox-exec.
// Keep the listener on loopback, redirect the account shell's startup to the fixture,
// and sandbox both the client and the authenticated command. sshd still resolves the existing
// uid and tries to chdir to its passwd home, but no user RC or key file is used from there.
// Opting in on an unsupported host or with an unusable local sshd is a test failure.
export async function makeLoopbackPickerFixture({
  allowPty = false,
  allowInteractiveShell = false,
  observeLocale = false,
  pairedPeerEcho = false,
  ipv6 = false,
  boundIdleMasterLifetime = false,
  pauseFirstPickerCommand = false,
  authenticationGate = false,
  snapshotCancellation = false,
} = {}) {
  if (
    pauseFirstPickerCommand &&
    (allowPty || allowInteractiveShell || observeLocale || pairedPeerEcho)
  )
    throw new Error("The cancel fixture admits only the direct folder picker.");
  const loopback = ipv6 ? "::1" : "127.0.0.1";
  const addressFamily = ipv6 ? "inet6" : "inet";
  if (allowInteractiveShell && observeLocale) {
    throw new Error("Interactive fixture sessions do not accept locale overrides.");
  }
  if (pairedPeerEcho && (allowPty || allowInteractiveShell || observeLocale)) {
    throw new Error("The paired-peer fixture accepts only the fixed binary echo command.");
  }
  const permitTty = allowPty || allowInteractiveShell;
  if (process.platform !== "darwin" || process.getuid?.() === 0) {
    throw new Error(
      "BIGBUD_TEST_PICKER_LOOPBACK requires non-root macOS with sandbox-exec and OpenSSH.",
    );
  }
  const account = userInfo();
  // Bun on macOS can return an "unknown" username for a valid uid.
  const username = execFileSync("/usr/bin/id", ["-un"], {
    encoding: "utf8",
    env: {},
    timeout: 2_000,
  }).trim();
  if (
    !/^[a-zA-Z0-9_-]+$/.test(username) ||
    !["/bin/sh", "/bin/bash", "/bin/zsh"].includes(account.shell ?? "")
  ) {
    throw new Error(
      "Fixture requires a local account with a simple username and a supported built-in shell.",
    );
  }
  for (const hook of ["/etc/ssh/sshrc", "/etc/zshenv", "/etc/zsh/zshenv"]) {
    if (existsSync(hook))
      throw new Error(`Fixture will not run with a system SSH or shell startup hook: ${hook}`);
  }
  const root = await mkdtemp(
    snapshotCancellation
      ? "/private/tmp/bigbud-snapshot-sshd-"
      : "/private/tmp/bigbud-picker-sshd-",
  );
  try {
    const home = path.join(root, "home");
    const folder = snapshotCancellation
      ? path.join(root, "workspace")
      : path.join(home, "picker's folders; literal");
    const bin = path.join(root, "bin");
    const identity = path.join(root, "identity");
    const hostKey = path.join(root, "host-key");
    const wrongKey = path.join(root, "wrong-host-key");
    const authorizedKeys = path.join(root, "authorized_keys");
    const policy = path.join(root, "client.sb");
    const commandPolicy = path.join(root, "command.sb");
    const serverConfig = path.join(root, "sshd_config");
    const changedServerConfig = path.join(root, "sshd_config.changed");
    const clientConfig = path.join(root, "ssh_config");
    const knownHosts = path.join(root, "known_hosts");
    const launchLog = path.join(root, "launches");
    await mkdir(bin);
    await mkdir(home, { mode: 0o700 });
    await mkdir(path.join(folder, "alpha"), { recursive: true });
    await mkdir(path.join(folder, "Z repo", ".git"), { recursive: true });
    await mkdir(path.join(folder, ".hidden"));
    await writeFile(path.join(folder, "not a folder"), "fixture\n");
    await writeFile(knownHosts, "", { mode: 0o600 });
    await writeFile(launchLog, "");

    const port = await reserveLoopbackPort(loopback);
    const homes = new Set<string>();
    for (const candidate of [account.homedir, process.env.HOME]) {
      if (!candidate || !path.isAbsolute(candidate)) continue;
      homes.add(candidate);
      homes.add(await realpath(candidate));
    }
    await writeFile(policy, sandboxPolicy([...homes], port));
    if (!allowInteractiveShell) await writeFile(commandPolicy, sandboxPolicy([...homes]));
    const env = { HOME: home, PATH: bin, TMPDIR: root, LC_ALL: "C" };
    const run = (binary: string, args: string[]) =>
      execFileSync(sandbox, ["-f", policy, binary, ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 5_000,
      });
    for (const key of [identity, hostKey, wrongKey]) {
      run(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-C", "picker-fixture", "-f", key]);
    }
    const publicKey = async (key: string) =>
      (await readFile(`${key}.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" ");
    const hostPublicKey = await publicKey(hostKey);
    const wrongPublicKey = await publicKey(wrongKey);
    await writeFile(
      authorizedKeys,
      `restrict${permitTty ? ",pty" : ""} ${await publicKey(identity)}\n`,
      {
        mode: 0o600,
      },
    );
    const version = (binary: string) => {
      const result = spawnSync(sandbox, ["-f", policy, binary, "-V"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 5_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      if (result.error || result.status !== 0 || !output.startsWith("OpenSSH_")) {
        throw new Error(`Could not determine fixture version of ${binary}: ${output}`, {
          cause: result.error,
        });
      }
      return output;
    };
    const versions = { client: version(ssh), server: version(sshd) };
    const localeObservation = path.join(root, "locale-observation");
    let remoteShell = pairedPeerEcho
      ? `/bin/sh -c '[ "$SSH_ORIGINAL_COMMAND" = bigbud-peer ] && exec /bin/cat'`
      : '/bin/sh -c "$SSH_ORIGINAL_COMMAND"';
    if (observeLocale) {
      const observer = path.join(root, "observe-locale");
      await writeFile(
        observer,
        `printf 'LANG=%s\\nLC_TIME=%s\\n' "\${LANG-<unset>}" "\${LC_TIME-<unset>}" >> '${localeObservation}' || exit 1\n` +
          `exec ${remoteShell}\n`,
      );
      // Observe inside the command sandbox, without changing the picker stdout.
      remoteShell = `/bin/sh ${observer}`;
    }
    const authGate = authenticationGate
      ? await prepareAuthenticationGate(root, authorizedKeys, username)
      : undefined;
    const heldRead = path.join(root, "held-picker-read");
    const releaseRead = path.join(root, "release-picker-read");
    if (pauseFirstPickerCommand) {
      const script = path.join(root, "hold-first-picker-read");
      await writeFile(
        script,
        [
          `if /bin/mkdir '${heldRead}' 2>/dev/null; then`,
          `  i=0; while [ ! -f '${releaseRead}' ] && [ "$i" -lt 80 ]; do /bin/sleep 0.1; i=$((i+1)); done`,
          "  exit 1",
          "fi",
          'exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"',
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      remoteShell = `/bin/sh ${script}`;
    }
    const command = allowInteractiveShell
      ? await prepareInteractiveCommand({ root, home, folder, sandbox, commandPolicy })
      : {
          setEnv: `HOME=${home} ZDOTDIR=${home} PATH=/usr/bin:/bin LC_ALL=C`,
          forceCommand: `cd ${home} && exec ${sandbox} -f ${commandPolicy} ${remoteShell}`,
        };
    await writeFile(
      serverConfig,
      [
        `AddressFamily ${addressFamily}`,
        `ListenAddress [${loopback}]:${port}`,
        `HostKey ${hostKey}`,
        ...(authGate?.sshdConfig ?? [`AuthorizedKeysFile ${authorizedKeys}`]),
        `AllowUsers ${username}`,
        // sshd runs as the existing non-root user; never use their actual home or login credentials.
        `SetEnv ${command.setEnv}`,
        `ForceCommand ${command.forceCommand}`,
        // Accept both names so the negative check exercises SendEnv, not server rejection.
        ...(observeLocale ? ["AcceptEnv LANG LC_TIME"] : []),
        "LogLevel VERBOSE",
        "PidFile none",
        "UseDNS no",
        "UsePAM no",
        "StrictModes no",
        "AuthenticationMethods publickey",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PermitUserEnvironment no",
        "PermitUserRC no",
        "DisableForwarding yes",
        // The crash fixture must not leave an authenticated idle child behind.
        ...(boundIdleMasterLifetime ? ["UnusedConnectionTimeout 8s"] : []),
        `PermitTTY ${permitTty ? "yes" : "no"}`,
        "",
      ].join("\n"),
    );
    await writeFile(
      changedServerConfig,
      (await readFile(serverConfig, "utf8")).replace(
        `HostKey ${hostKey}\n`,
        `HostKey ${wrongKey}\n`,
      ),
    );
    await writeFile(
      clientConfig,
      [
        "Host *",
        `AddressFamily ${addressFamily}`,
        "StrictHostKeyChecking yes",
        `UserKnownHostsFile ${knownHosts}`,
        "GlobalKnownHostsFile none",
        "HashKnownHosts no",
        "UpdateHostKeys no",
        "VerifyHostKeyDNS no",
        "IdentityFile none",
        "IdentityAgent none",
        "IdentitiesOnly yes",
        "ControlMaster no",
        "ControlPath none",
        "ClearAllForwardings yes",
        "ForwardAgent no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "ConnectTimeout 2",
        "ConnectionAttempts 1",
        "",
      ].join("\n"),
    );
    for (const [name, command] of [
      ["ssh", `${ssh} -F ${clientConfig}`],
      ["ssh-keygen", sshKeygen],
    ] as const) {
      await writeFile(
        path.join(bin, name),
        `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${launchLog}' || exit 1\n` +
          `cd '${root}' || exit 1\nexec ${sandbox} -f '${policy}' ${command} "$@"\n`,
        { mode: 0o700 },
      );
    }
    const target = new URLSearchParams({
      host: loopback,
      port: String(port),
      user: username,
      auth: "ssh-key",
      keyPath: identity,
      transport: "agent",
    });

    let daemon: { child: ChildProcess; closed: Promise<void> } | undefined;
    let daemonLog = "";
    async function start(hostIdentity: "original" | "changed" = "original") {
      if (daemon) throw new Error("Fixture sshd must be stopped before starting it again.");
      daemonLog = "";
      const config = hostIdentity === "original" ? serverConfig : changedServerConfig;
      const child = spawn(sshd, ["-D", "-e", "-f", config], {
        cwd: root,
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      daemon = { child, closed: new Promise<void>((resolve) => child.once("close", resolve)) };
      child.stderr?.on("data", (chunk: Buffer) => {
        daemonLog = (daemonLog + chunk.toString()).slice(-8192);
      });
      await waitForListener(child, loopback, port);
    }

    async function stop() {
      if (!daemon) return;
      const { child, closed } = daemon;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
        daemon = undefined;
      }
    }

    return {
      root,
      env,
      home,
      folder,
      knownHosts,
      loopback,
      port,
      user: username,
      identity,
      clientSandboxPolicy: policy,
      host: `[${loopback}]:${port}`,
      executionTargetId: `ssh:${target}`,
      hostPublicKey,
      wrongPublicKey,
      versions,
      ssh,
      sshd,
      authGate,
      start,
      stop,
      dispose: async () => {
        await stop();
        await rm(root, { recursive: true, force: true });
      },
      launchNames: async () =>
        (await readFile(launchLog, "utf8")).trim().split("\n").filter(Boolean),
      readLocaleObservation: () => readFile(localeObservation, "utf8"),
      acceptedPublicKeys: () => daemonLog.match(/^Accepted publickey /gm)?.length ?? 0,
      connectionStarts: () => daemonLog.match(/^Connection from /gm)?.length ?? 0,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

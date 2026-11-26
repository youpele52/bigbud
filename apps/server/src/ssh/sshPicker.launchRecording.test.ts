import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { discoverSshConfigHosts } from "./sshConfigDiscovery.ts";
import { inspectSshHostTrust, trustSshHost } from "./sshHostTrust.ts";
import { listRemoteFolders } from "./sshRemoteFolders.ts";
import {
  configureSshTargetDisconnects,
  markSshTargetDisconnected,
  RemoteTargetDisconnectedError,
} from "./sshTargetDisconnects.ts";
import { SshTargetAuthRequiredError } from "./sshTargetUnavailable.ts";
import { verifySshExecutionTarget } from "./sshVerification.ts";

const alias = "picker-fixture";
function explicitKeyTarget(home: string): string {
  const keyPath = encodeURIComponent(path.join(home, ".ssh", "fake_key"));
  return `ssh:host=${alias}&user=alice&port=2222&auth=ssh-key&keyPath=${keyPath}&transport=agent`;
}
const prompt =
  "The authenticity of host '[picker-fixture]:2222' can't be established.\n" +
  "ED25519 key fingerprint is SHA256:fixtureKey.\n" +
  "Are you sure you want to continue connecting (yes/no/[fingerprint])?";

const recorder = String.raw`
const { spawnSync } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");
const { basename } = require("node:path");
const [entry, ...args] = process.argv.slice(2);
const tool = basename(entry);
const env = process.env;
const record = (event) => appendFileSync(env.FIXTURE_LOG, JSON.stringify(event) + "\n");
record({
  entry, args, cwd: process.cwd(), env: {
    HOME: env.HOME, PATH: env.PATH, SSH_AUTH_SOCK: env.SSH_AUTH_SOCK,
    DISPLAY: env.DISPLAY, LC_ALL: env.LC_ALL, SSH_ASKPASS: env.SSH_ASKPASS,
    SSH_ASKPASS_REQUIRE: env.SSH_ASKPASS_REQUIRE,
    approvedPrompt: env.BIGBUD_SSH_APPROVED_PROMPT,
    promptFile: env.BIGBUD_SSH_TRUST_PROMPT_FILE,
    hasCredential: "BIGBUD_SSH_PASSWORD" in env || "BIGBUD_SSH_KEY_PASSPHRASE" in env,
  },
});
if (tool === "ssh-keygen") process.exit(0);
if (tool !== "ssh") process.exit(91);
if (args.includes("PreferredAuthentications=none")) {
  const presented = env.FIXTURE_TRUST_PROMPT;
  const ask = (text) => spawnSync(env.SSH_ASKPASS, [text], { encoding: "utf8" });
  const auth = ask("alice@picker-fixture's password:");
  const answer = ask(presented);
  record({ askpass: { authStatus: auth.status, authAnswer: auth.stdout, status: answer.status, answer: answer.stdout } });
  process.stderr.write(answer.stdout === "yes\n" ? "Permission denied (publickey)." : "Host key verification failed.");
  process.exitCode = 255;
} else if (args[0] === "-T" && args.at(-1).includes("BIGBUD_REMOTE_FOLDERS_V1")) {
  record({ stdin: readFileSync(0, "utf8") });
  switch (env.FIXTURE_FOLDER_RESULT) {
    case "missing": process.exitCode = 3; break;
    case "malformed": process.stdout.write("unexpected output"); break;
    case "oversize": {
      // Put the final record terminator one byte past the 1 MiB boundary.
      const listing = "BIGBUD_REMOTE_FOLDERS_V1\0/fixture\0/fixture\0d\tkept\0d\tcut\0";
      process.stdout.write("x".repeat(1024 * 1024 + 1 - listing.length) + listing);
      break;
    }
    default:
      process.stdout.write("login banner\nBIGBUD_REMOTE_FOLDERS_V1\0/fixture\0/fixture/selected\0g\tZ repo\0d\talpha\0");
  }
} else {
  // Never run the remote command or delegate to system SSH.
  process.exitCode = 92;
}
`;

// Literal legacy wire baseline. Do not build this from the production invocation or script.
const folderWrapper =
  'if [ -n "$1" ]; then cd "$1" || exit 1; fi; shift; while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do export "$1"; shift; done; shift; exec "$@"';
const folderScript = String.raw`target="$1"
MARKER=BIGBUD_REMOTE_FOLDERS_V1
case "$target" in
  "") cd || exit 3 ;;
  "~") cd || exit 3 ;;
  "~/"*) cd -- "$HOME/${"${target#\\~/}"}" || exit 3 ;;
  *) cd -- "$target" || exit 3 ;;
esac
printf '%s\0%s\0%s\0' "$MARKER" "$HOME" "$(pwd)"
for entry in *; do
  [ -d "$entry" ] || continue
  if [ -e "$entry/.git" ]; then kind=g; else kind=d; fi
  printf '%s\t%s\0' "$kind" "$entry"
done`;

function folderCommand(folder: string): string {
  return ["sh", "-lc", folderWrapper, "sh", "", "--", "sh", "-c", folderScript, "sh", folder]
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

const trustArgs = [
  "-T",
  "-o",
  "BatchMode=no",
  "-o",
  "StrictHostKeyChecking=ask",
  "-o",
  "FingerprintHash=sha256",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "ControlPath=none",
  "-o",
  "PreferredAuthentications=none",
  "-o",
  "PubkeyAuthentication=no",
  "-o",
  "PasswordAuthentication=no",
  "-o",
  "KbdInteractiveAuthentication=no",
  "-o",
  "NumberOfPasswordPrompts=0",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ConnectionAttempts=1",
  "-p",
  "2222",
  "--",
  "alice@picker-fixture",
  "true",
];

async function trustChallenge(
  target: string,
  probe: Promise<unknown>,
): Promise<SshHostTrustChallenge> {
  try {
    await probe;
  } catch (error) {
    if (!(error instanceof SshTargetAuthRequiredError) || error.authMode !== "host-trust") {
      throw error;
    }
    expect(error.executionTargetId).toBe(target);
    expect(error.message).toMatch(/^SSH host trust is required: /);
    return JSON.parse(error.message.slice("SSH host trust is required: ".length));
  }
  throw new Error("Expected the recorder's synthetic host trust challenge.");
}

// These are real POSIX child launches into a recorder, not live OpenSSH sessions.
describe.skipIf(process.platform === "win32")("F01 legacy picker launch recording", () => {
  let root: string;
  let home: string;
  let bin: string;
  let log: string;
  let inheritedEnv: NodeJS.ProcessEnv;

  async function launches(): Promise<unknown[]> {
    const events = (await fs.readFile(log, "utf8")).trim();
    return events ? events.split("\n").map((event) => JSON.parse(event)) : [];
  }

  function clientEnv() {
    return {
      HOME: home,
      PATH: bin,
      SSH_AUTH_SOCK: path.join(root, "synthetic-agent.sock"),
      DISPLAY: "fixture:0",
      LC_ALL: "POSIX",
      hasCredential: false,
    };
  }

  function launch(tool: string, args: string[], env = clientEnv()) {
    return { entry: path.join(bin, tool), cwd: process.cwd(), args, env };
  }

  beforeEach(async () => {
    inheritedEnv = process.env;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-ssh-f01-"));
    home = path.join(root, "synthetic home");
    bin = path.join(root, "bin");
    log = path.join(root, "launches.jsonl");
    const sshDir = path.join(home, ".ssh");
    const program = path.join(root, "recorder.cjs");
    await fs.mkdir(path.join(sshDir, "conf.d"), { recursive: true });
    await fs.mkdir(bin);
    await fs.writeFile(path.join(sshDir, "fake_key"), "not a private key\n");
    await fs.writeFile(log, "");
    await fs.writeFile(program, recorder);
    for (const name of ["ssh", "ssh-keygen", "ssh-add", "ssh-agent"]) {
      await fs.writeFile(
        path.join(bin, name),
        '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_PROGRAM" "$0" "$@"\n',
        { mode: 0o700 },
      );
    }
    // No ambient credentials, helper paths, config roots or agent sockets are passed to children.
    const { hasCredential: _, ...env } = clientEnv();
    process.env = {
      ...env,
      TMPDIR: root,
      FIXTURE_NODE: process.execPath,
      FIXTURE_PROGRAM: program,
      FIXTURE_LOG: log,
      FIXTURE_TRUST_PROMPT: prompt,
    };
  });

  afterEach(async () => {
    process.env = inheritedEnv;
    configureSshTargetDisconnects(undefined, []);
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("discovers a synthetic alias without launching anything, then passes the alias to SSH", async () => {
    const sshDir = path.join(home, ".ssh");
    const config = path.join(sshDir, "config");
    await fs.writeFile(config, 'Include conf.d/*.conf\nMatch exec "ssh --match-exec"\n');
    await fs.writeFile(
      path.join(sshDir, "conf.d", "picker.conf"),
      "Host picker-fixture *.invalid\n  HostName synthetic.invalid\n  User config-user\n  Port 2222\n  ProxyCommand ssh --proxy\n",
    );
    const result = await discoverSshConfigHosts({
      roots: [{ path: config, kind: "user", includeBaseDir: sshDir }],
      homeDir: home,
      machineName: "fixture desktop",
    });
    expect(result).toEqual({
      machineName: "fixture desktop",
      hosts: [
        {
          alias: "picker-fixture",
          hostName: "synthetic.invalid",
          user: "config-user",
          port: "2222",
          sourcePath: "~/.ssh/conf.d/picker.conf",
          line: 1,
        },
      ],
      sources: [
        { path: "~/.ssh/config", kind: "user", status: "loaded" },
        { path: "~/.ssh/conf.d/picker.conf", kind: "include", status: "loaded" },
      ],
    });
    expect(await launches()).toEqual([]);
    const folder = "~/repo's files; $(not-a-command)";
    await expect(
      listRemoteFolders({ executionTargetId: `ssh:${result.hosts[0]!.alias}`, path: folder }),
    ).resolves.toEqual({
      path: "/fixture/selected",
      homePath: "/fixture",
      folders: [
        { name: "alpha", isGitRepo: false },
        { name: "Z repo", isGitRepo: true },
      ],
      truncated: false,
    });
    expect(await launches()).toEqual([
      launch("ssh", ["-T", "-o", "BatchMode=yes", "--", "picker-fixture", folderCommand(folder)]),
      { stdin: "" },
    ]);
  });

  it("records the explicit identity probe before the folder launch even for agent transport", async () => {
    const key = path.join(home, ".ssh", "fake_key");
    await expect(
      listRemoteFolders({ executionTargetId: explicitKeyTarget(home) }),
    ).resolves.toHaveProperty("truncated", false);
    expect(await launches()).toEqual([
      launch("ssh-keygen", ["-y", "-P", "", "-f", key]),
      launch("ssh", [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-p",
        "2222",
        "-i",
        key,
        "--",
        "alice@picker-fixture",
        folderCommand(""),
      ]),
      { stdin: "" },
    ]);
  });

  it("preserves folder status, malformed output and the 1 MiB stdout truncation", async () => {
    const input = { executionTargetId: `ssh:${alias}`, path: "/fixture/missing" };
    process.env.FIXTURE_FOLDER_RESULT = "missing";
    await expect(listRemoteFolders(input)).rejects.toThrow(
      "Folder not found or not accessible: /fixture/missing",
    );
    process.env.FIXTURE_FOLDER_RESULT = "malformed";
    await expect(listRemoteFolders(input)).rejects.toThrow("unexpected folder listing");
    process.env.FIXTURE_FOLDER_RESULT = "oversize";
    await expect(listRemoteFolders(input)).resolves.toEqual({
      path: "/fixture",
      homePath: "/fixture",
      folders: [{ name: "kept", isGitRepo: false }],
      truncated: true,
    });
  });

  it("records credential-free trust probes and answers only the exact approved prompt", async () => {
    const keyTarget = explicitKeyTarget(home);
    const original = await trustChallenge(keyTarget, inspectSshHostTrust(keyTarget));
    expect(original).toMatchObject({
      host: "[picker-fixture]:2222",
      keyType: "ED25519",
      fingerprint: "SHA256:fixtureKey",
    });
    const differentPrompt = prompt.replace("fixtureKey", "differentKey");
    process.env.FIXTURE_TRUST_PROMPT = differentPrompt;
    const different = await trustChallenge(
      keyTarget,
      trustSshHost({ executionTargetId: keyTarget, challengeId: original.challengeId }),
    );
    expect(different.fingerprint).toBe("SHA256:differentKey");
    await expect(
      trustSshHost({ executionTargetId: keyTarget, challengeId: different.challengeId }),
    ).resolves.toEqual({ message: "SSH server identity trusted. Continue connecting." });
    const trustLaunch = (approvedPrompt: string) => ({
      ...launch("ssh", trustArgs),
      env: {
        ...clientEnv(),
        LC_ALL: "C",
        SSH_ASKPASS_REQUIRE: "force",
        approvedPrompt,
        SSH_ASKPASS: expect.stringMatching(/\/bigbud-ssh-trust-[^/]+\/askpass\.sh$/),
        promptFile: expect.stringMatching(/\/bigbud-ssh-trust-[^/]+\/prompt$/),
      },
    });
    const refused = { askpass: { authStatus: 1, authAnswer: "", status: 1, answer: "" } };
    expect(await launches()).toEqual([
      trustLaunch(""),
      refused,
      trustLaunch(prompt),
      refused,
      trustLaunch(differentPrompt),
      { askpass: { authStatus: 1, authAnswer: "", status: 0, answer: "yes\n" } },
    ]);
  });

  it("rejects picker, verification and trust calls with no recorded launch after Disconnect", async () => {
    const keyTarget = explicitKeyTarget(home);
    expect(await markSshTargetDisconnected(keyTarget)).toBe(true);
    await expect(listRemoteFolders({ executionTargetId: keyTarget })).rejects.toBeInstanceOf(
      RemoteTargetDisconnectedError,
    );
    await expect(verifySshExecutionTarget({ executionTargetId: keyTarget })).rejects.toBeInstanceOf(
      RemoteTargetDisconnectedError,
    );
    await expect(inspectSshHostTrust(keyTarget)).rejects.toBeInstanceOf(
      RemoteTargetDisconnectedError,
    );
    expect(await launches()).toEqual([]);
  });
});

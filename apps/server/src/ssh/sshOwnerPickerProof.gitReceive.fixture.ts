import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const branch = "refs/heads/main";
export const gitEnv = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export function git(cwd: string, args: string[], input?: string) {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    env: gitEnv,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
}

export function init(root: string, name: string) {
  git(root, [
    "init",
    "--bare",
    "--template=",
    "--object-format=sha1",
    "--initial-branch=main",
    name,
  ]);
  return path.join(root, name);
}

export function seed(repo: string, label: string, parent?: string) {
  const blob = git(repo, ["hash-object", "-w", "--stdin"], `${label}\n`);
  const tree = git(repo, ["mktree"], `100644 blob ${blob}\tproof.txt\n`);
  const who = "Fixture <fixture@example.invalid> 1700000000 +0000";
  return git(
    repo,
    ["hash-object", "-w", "-t", "commit", "--stdin"],
    `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${who}\ncommitter ${who}\n\n${label}\n`,
  );
}

function publicKey(text: string) {
  const key = /^ssh-ed25519 [A-Za-z0-9+/]{68}(?=\s)/.exec(text)?.[0];
  if (!key) throw new Error("Expected a generated Ed25519 fixture key");
  return key;
}

// The only authorized fixture key can execute only this recipe. In particular,
// neither Git's URL path nor any SSH-supplied text selects a shell command.
export async function configureReceiver(
  root: string,
  identity: string,
  knownHosts: string,
  port: number,
  old: string,
  approved: string,
  wrongKey: boolean,
) {
  const commandPath = path.join(root, "receive-only");
  const callerKey = publicKey(await readFile(`${identity}.pub`, "utf8"));
  const hostKey = publicKey(await readFile(path.join(root, "host-key.pub"), "utf8"));
  await writeFile(knownHosts, `[127.0.0.1]:${port} ${wrongKey ? callerKey : hostKey}\n`, {
    mode: 0o600,
  });
  await writeFile(
    path.join(root, "authorized_keys"),
    `restrict,command="/bin/bash ${commandPath}" ${callerKey}\n`,
    { mode: 0o600 },
  );
  const hooks = path.join(root, "receive-hooks");
  await mkdir(hooks, { mode: 0o700 });
  await writeFile(path.join(root, "approved-update"), `${old} ${approved} ${branch}\n`, {
    mode: 0o600,
  });
  await writeFile(
    path.join(hooks, "pre-receive"),
    `#!/bin/sh
set -eu
printf 'entered\\n' > '${root}/hook-entered'
exec /usr/bin/cmp -s '${root}/approved-update' -
`,
    { mode: 0o700 },
  );
  await writeFile(
    commandPath,
    `
set -eu
umask 077
[[ $SSH_ORIGINAL_COMMAND == "git-receive-pack '/receive.git'" ]] || exit 126
root='${root}'
[[ ! -L $root && $(/usr/bin/stat -c '%u:%a' -- "$root") == "$EUID:700" ]] || exit 126
[[ ! -L $root/receive.git && ! -L $root/receive.git/refs/heads/main ]] || exit 126
cd -P -- "$root/receive.git"
[[ $PWD == "$root/receive.git" && $(/usr/bin/git for-each-ref --format='%(objectname) %(refname)') == '${old} ${branch}' ]] || exit 126
printf 'entered\\n' > "$root/receiver-entered"
exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \\
  "GIT_TRACE_PACKET=$root/receive.trace" \\
  /usr/bin/timeout --kill-after=1s 9s /usr/bin/git --git-dir=. -c receive.maxInputSize=65536 \\
  -c receive.fsckObjects=true -c receive.denyNonFastForwards=true -c receive.denyDeletes=true \\
  -c "core.hooksPath=$root/receive-hooks" receive-pack .
`,
    { mode: 0o600 },
  );
}

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { machineIdentityFromPlatformId } from "@bigbud/shared/machineIdentity";

import { makeLocalWorkspaceModeStore } from "./workspaceMode.local.ts";
import { makeShellWorkspaceModeStore } from "./workspaceMode.ssh.ts";

const execute = promisify(execFile);

export const RAW_MACHINE_ID = "0123456789abcdef0123456789abcdef";
export const HOST_IDENTITY = machineIdentityFromPlatformId(RAW_MACHINE_ID);
export const OWNER_A = `backend-v1:${"a".repeat(64)}`;
export const OWNER_B = `backend-v1:${"b".repeat(64)}`;

// The production script targets Linux; these adapters only point host facts at the temp account
// (and translate sha256sum on Darwin). Realpath, CAS, permissions and links run unmodified.
const hostAdapters = `
uname() { echo Linux; }
getent() { printf 'test:x:%s:0::%s:/bin/sh\\n' "$2" "$TEST_HOME"; }
cat() { if test "$1" = /etc/machine-id; then command cat "$TEST_MACHINE_ID"; else command cat "$@"; fi; }
${process.platform === "darwin" ? "sha256sum() { command shasum -a 256; }" : ""}
`;

export function makeWorkspaceModeFixture() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bigbud-wsmode-")));
  const home = path.join(base, "home");
  const workspace = path.join(base, "projects", "app");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workspace, { recursive: true });
  const machineIdFile = path.join(base, "machine-id");
  writeFileSync(machineIdFile, `${RAW_MACHINE_ID}\n`);
  const scripts: string[] = [];
  const runShell = async (script: string) => {
    scripts.push(script);
    const result = await execute("/bin/sh", ["-c", `${hostAdapters}\n${script}`], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LC_ALL: "C",
        TEST_HOME: home,
        TEST_MACHINE_ID: machineIdFile,
      },
      timeout: 10_000,
    });
    return result.stdout;
  };
  return {
    base,
    home,
    workspace,
    scripts,
    runShell,
    shellStore: makeShellWorkspaceModeStore(runShell),
    localStore: makeLocalWorkspaceModeStore({
      home,
      hostIdentity: HOST_IDENTITY,
      accountUid: process.getuid!(),
    }),
    modesDir: path.join(home, ".bigbud", "workspace-modes"),
    close: () => rmSync(base, { recursive: true, force: true }),
  };
}

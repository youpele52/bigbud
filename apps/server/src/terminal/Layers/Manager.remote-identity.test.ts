import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "../../utils/processRunner.ts";
import {
  createRemoteShellPidReader,
  remoteShellPidPrefix,
  remoteShellStartup,
} from "./Manager.remote-identity.ts";

it("strips remote PID evidence at every possible chunk boundary without stripping normal output", () => {
  const marker = `${remoteShellPidPrefix("runtime")}1234\x07`;
  const data = `banner\r\n${marker}prompt\x1b]2;agent title\x07`;
  for (let split = 0; split <= data.length; split++) {
    const pids: number[] = [];
    const read = createRemoteShellPidReader("runtime", (pid) => pids.push(pid));
    expect(read(data.slice(0, split)) + read(data.slice(split))).toBe(
      "banner\r\nprompt\x1b]2;agent title\x07",
    );
    expect(pids).toEqual([1234]);
  }
  const pids: number[] = [];
  const read = createRemoteShellPidReader("runtime", (pid) => pids.push(pid));
  expect([...data].map(read).join("")).toBe("banner\r\nprompt\x1b]2;agent title\x07");
  expect(pids).toEqual([1234]);
});

it("ignores foreign runtimes and malformed markers, with bounded buffering", () => {
  const pids: number[] = [];
  const read = createRemoteShellPidReader("new", (pid) => pids.push(pid));
  const foreign = `${remoteShellPidPrefix("old")}100\x07`;
  expect(read(foreign)).toBe(foreign);
  for (const value of ["0", "1", "nan", "9007199254740992", "1".repeat(2000)]) {
    const text = `${remoteShellPidPrefix("new")}${value}\x07`;
    expect(read(text)).toBe(text);
  }
  expect(pids).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "keeps the shell environment and exec PID when invoking the login shell",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bigbud-shell-identity-"));
    const shell = path.join(directory, "login-shell");
    try {
      await writeFile(shell, '#!/bin/sh\nprintf "%s|%s|%s|%s" "$$" "$1" "$KEEP_ME" "$PATH"\n', {
        mode: 0o700,
      });
      const result = await runProcess("/bin/sh", ["-c", remoteShellStartup("runtime")], {
        env: { ...process.env, SHELL: shell, KEEP_ME: "remote-value", PATH: "/usr/bin:/bin" },
        timeoutMs: 1000,
      });
      let pid = 0;
      const read = createRemoteShellPidReader("runtime", (value) => {
        pid = value;
      });
      expect(read(result.stdout)).toBe(`${pid}|-l|remote-value|/usr/bin:/bin`);
      expect(pid).toBeGreaterThan(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

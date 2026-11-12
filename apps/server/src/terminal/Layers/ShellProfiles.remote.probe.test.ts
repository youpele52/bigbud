import os from "node:os";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../utils/processRunner";
import * as Effect from "effect/Effect";
import { discoverRemoteShellProfiles } from "./ShellProfiles.remote";
import { remoteShellHost } from "./ShellProfiles.remote.identity";
import {
  decodeRemoteShellInventory,
  REMOTE_SHELL_CLEAN_SCRIPT,
  REMOTE_SHELL_OUTPUT_BYTES,
  REMOTE_SHELL_PROBE_SCRIPT,
} from "./ShellProfiles.remote.protocol";

/** Only the trusted static probe runs locally; never invoke SSH or WSL from these fixtures. */
const probe = (args: readonly string[]) =>
  runProcess(
    "/usr/bin/env",
    [
      "-i",
      "PATH=/nonexistent-untrusted-path",
      "LC_ALL=C",
      "/bin/sh",
      "-c",
      REMOTE_SHELL_PROBE_SCRIPT,
      "sh",
      ...args,
    ],
    {
      cwd: os.tmpdir(),
      env: {},
      shell: false,
      timeoutMs: 2000,
      settleOnTimeout: true,
      maxBufferBytes: REMOTE_SHELL_OUTPUT_BYTES,
      allowNonZeroExit: true,
    },
  );

describe.skipIf(process.platform === "win32")(
  "trusted static remote inventory probe (local fixture)",
  () => {
    it("runs only fixed utilities/builtins without PATH, profiles or candidate execution", async () => {
      const result = await probe(["ssh", os.userInfo().username]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const profiles = decodeRemoteShellInventory(
        result.stdout,
        remoteShellHost({ executionTargetId: `ssh:${os.userInfo().username}@fixture` }),
      );
      expect(profiles.some((profile) => profile.displayName === "sh")).toBe(true);
      expect(profiles.length).toBeLessThanOrEqual(20);
      expect(profiles.every((profile) => profile.platform === process.platform)).toBe(true);
      // The only external utilities are fixed id/uname. Candidates only appear in -f/-x tests.
      expect(REMOTE_SHELL_PROBE_SCRIPT).not.toMatch(/exec|eval|source|readlink|realpath/);
      expect(REMOTE_SHELL_PROBE_SCRIPT).toContain('[ -f "$candidate" ] && [ -x "$candidate" ]');
    });

    it("rejects an SSH effective account mismatch before emitting inventory", async () => {
      for (const username of ["", `${os.userInfo().username}-mismatch`, "$(not-shell-source)"]) {
        const result = await probe(["ssh", username]);
        expect(result.code).toBe(79);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
      }
    });

    it("maps a real effective-account mismatch through fake SSH transport to a typed failure", async () => {
      let probed = false;
      const error = await Effect.runPromise(
        discoverRemoteShellProfiles(
          {
            executionTargetId: `ssh:host=fixture&user=${encodeURIComponent(os.userInfo().username + "-mismatch")}&transport=direct-ssh`,
          },
          {
            runSshCommand: (input) => {
              probed = true;
              return runProcess(input.command, input.args ?? [], {
                cwd: os.tmpdir(),
                env: {},
                shell: false,
                signal: input.signal,
                timeoutMs: 2000,
                settleOnTimeout: true,
                allowNonZeroExit: true,
                maxBufferBytes: REMOTE_SHELL_OUTPUT_BYTES,
              });
            },
          },
        ).pipe(Effect.flip),
      );
      expect(probed).toBe(true);
      expect(error.reason).toBe("probe-failed");
    });

    it("rejects UID and username drift before emitting any inventory", async () => {
      const user = os.userInfo().username;
      const uid = process.getuid!();
      for (const args of [
        ["wsl", user, String(uid + 1)],
        ["wsl", "$(not-shell-source)", String(uid)],
      ]) {
        const result = await probe(args);
        expect(result.code).toBe(79);
        expect(result.stdout).toBe("");
      }
    });

    it("does not permit ambiguous modes/argument counts", async () => {
      for (const args of [
        [],
        ["ssh"],
        ["ssh", os.userInfo().username, "extra"],
        ["wsl"],
        ["agent"],
      ]) {
        const result = await probe(args);
        expect(result.code).toBe(79);
        expect(result.stdout).toBe("");
      }
    });

    it("the WSL clean wrapper preserves argv verbatim and reaches the UID check", async () => {
      const result = await runProcess(
        "/bin/sh",
        [
          "-c",
          REMOTE_SHELL_CLEAN_SCRIPT,
          "sh",
          REMOTE_SHELL_PROBE_SCRIPT,
          "wsl",
          os.userInfo().username,
          String(process.getuid!() + 1),
        ],
        {
          shell: false,
          env: {},
          cwd: os.tmpdir(),
          timeoutMs: 2000,
          settleOnTimeout: true,
          allowNonZeroExit: true,
          maxBufferBytes: REMOTE_SHELL_OUTPUT_BYTES,
        },
      );
      expect(result.code).toBe(79);
      expect(result.stdout).toBe("");
    });
  },
);

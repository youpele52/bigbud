import { runProcess } from "../utils/processRunner.ts";
import { describe, expect, it, vi } from "vitest";
import {
  findRemoteAgentRemoteCommandError,
  REMOTE_AGENT_STDERR_TAIL_BYTES,
  RemoteAgentRemoteCommandError,
  runRemoteAgentDiagnosedCommand,
  sanitizeRemoteAgentStderr,
} from "./remoteAgentDiagnostics.ts";

const timedOutRun = async () => ({ stdout: "", stderr: "", code: null, timedOut: true });
const input = { executionTargetId: "ssh:fixture", command: "sh", args: ["-lc", "secret-script"] };

describe("remote agent stderr sanitising", () => {
  it("keeps the tail within the byte bound and drops a partial leading line", () => {
    const noisy = `${"noise line\n".repeat(2_000)}final: GLIBC_2.34' not found`;
    const tail = sanitizeRemoteAgentStderr(noisy);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(REMOTE_AGENT_STDERR_TAIL_BYTES);
    expect(tail.endsWith("final: GLIBC_2.34' not found")).toBe(true);
    expect(tail.startsWith("noise line")).toBe(true);
  });

  it("strips terminal controls and redacts secrets", () => {
    const tail = sanitizeRemoteAgentStderr(
      `\x1b[31mred\x1b[0m\x07 token=abc123 Bearer xyz\n${"A".repeat(60)}\n-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----`,
    );
    for (const leaked of ["\u001b", "\u0007", "abc123", "xyz", "AAAA", "key\n"]) {
      expect(tail).not.toContain(leaked);
    }
    expect(tail).toContain("red");
    expect(tail).toContain("token=[redacted]");
  });
});

describe("diagnosed remote agent commands", () => {
  it("throws a typed error with the stderr tail and never the script", async () => {
    const run = vi.fn(async () => ({
      stdout: "",
      stderr: "sha256sum: not found\n",
      code: 127,
      signal: null,
      timedOut: false,
    }));
    const failure = await runRemoteAgentDiagnosedCommand(run, "install", input).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RemoteAgentRemoteCommandError);
    const error = failure as RemoteAgentRemoteCommandError;
    expect(error).toMatchObject({ stage: "install", exitCode: 127, timedOut: false });
    expect(error.stderrTail).toBe("sha256sum: not found");
    expect(error.message).not.toContain("secret-script");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ allowNonZeroExit: true, outputMode: "truncate" }),
    );
  });

  it("retains the loader error after more than 64 KiB of real process stderr", async () => {
    const failure = await runRemoteAgentDiagnosedCommand(
      (options) =>
        runProcess(
          process.execPath,
          [
            "-e",
            `process.stderr.write("setup noise\\n".repeat(20000)); process.stderr.write("GLIBC_2.34' not found\\n"); process.exitCode = 1;`,
          ],
          options,
        ),
      "check",
      input,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RemoteAgentRemoteCommandError);
    expect((failure as RemoteAgentRemoteCommandError).stderrTail).toContain(
      "GLIBC_2.34' not found",
    );
    expect(
      Buffer.byteLength((failure as RemoteAgentRemoteCommandError).stderrTail),
    ).toBeLessThanOrEqual(REMOTE_AGENT_STDERR_TAIL_BYTES);
  });

  it("reports timeouts and finds the error through cause chains", async () => {
    const failure = await runRemoteAgentDiagnosedCommand(timedOutRun, "install", input).catch(
      (error: unknown) => new Error("wrapped", { cause: error }),
    );
    expect(findRemoteAgentRemoteCommandError(failure)).toMatchObject({ timedOut: true });
  });

  it("enforces the caller's stdout bound and accepts results without exit metadata", async () => {
    await expect(
      runRemoteAgentDiagnosedCommand(async () => ({ stdout: "x".repeat(20), code: 0 }), "check", {
        ...input,
        maxBufferBytes: 10,
      }),
    ).rejects.toBeInstanceOf(RemoteAgentRemoteCommandError);
    await expect(
      runRemoteAgentDiagnosedCommand(async () => ({ stdout: "ok" }), "check", input),
    ).resolves.toEqual({ stdout: "ok", stderr: "" });
  });
});

import { Effect, Fiber } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { runProcess } from "../../utils/processRunner.ts";
import {
  inspectRemoteTerminalProcesses,
  parseRemoteTerminalProcesses,
  remoteInspectionInvocation,
} from "./Manager.remote-inspection.ts";

vi.mock("../../utils/processRunner.ts", () => ({ runProcess: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const target = "ssh:host=devbox&user=deploy&port=2222&auth=ssh-key";
const output =
  "banner\nbigbud-process-snapshot-start\n100 1 100 200 /bin/zsh\n200 100 200 200 gemini\nbigbud-process-snapshot-end\n";

it("reads POSIX snapshots while rejecting missing/empty/partial unsupported output", () => {
  expect(parseRemoteTerminalProcesses(output)).toHaveLength(2);
  for (const text of [
    "",
    "100 1 100 200 sh",
    output.replace("bigbud-process-snapshot-end", "oops"),
    "bigbud-process-snapshot-start\nbigbud-process-snapshot-end\n",
  ]) {
    expect(() => parseRemoteTerminalProcesses(text)).toThrow();
  }
});

it("bounds connection setup and reuses password control sessions without readiness probes", () => {
  const key = remoteInspectionInvocation(target);
  expect(key.command).toBe("ssh");
  expect(key.args).toEqual(
    expect.arrayContaining([
      "-T",
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "ConnectTimeout=2",
      "ConnectionAttempts=1",
      "ServerAliveInterval=2",
      "ServerAliveCountMax=1",
      "deploy@devbox",
    ]),
  );
  expect(key.args.at(-1)).toContain("LC_ALL=C ps -e -ww -o pid=,ppid=,pgid=,tpgid=,command=");
  expect(key.args.join(" ")).not.toMatch(/bigbud-remote-agent|env -i|sh -l/);
  const password = remoteInspectionInvocation(target.replace("auth=ssh-key", "auth=password"));
  expect(password.args).toContain("ControlMaster=no");
  expect(password.args.some((arg) => arg.startsWith("ControlPath="))).toBe(true);
  expect(vi.mocked(runProcess)).not.toHaveBeenCalled();
});

it("bounds execution/output and passes cancellation through to the SSH subprocess", async () => {
  vi.mocked(runProcess).mockResolvedValue({
    stdout: output,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  });
  expect(await Effect.runPromise(inspectRemoteTerminalProcesses(target))).toHaveLength(2);
  expect(vi.mocked(runProcess).mock.calls[0]?.[2]).toMatchObject({
    shell: false,
    timeoutMs: 3000,
    settleOnTimeout: true,
    maxBufferBytes: 2 * 1024 * 1024,
    outputMode: "error",
    signal: expect.any(AbortSignal),
  });
  let cancelled = false;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(runProcess).mockImplementation(
    (_command, _args, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          cancelled = true;
          reject(new Error("cancelled"));
        });
        started();
      }),
  );
  const fiber = Effect.runFork(inspectRemoteTerminalProcesses(target));
  await ready;
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(cancelled).toBe(true);
});

it("treats failures, including output overflow and SSH timeout, as inspection errors", async () => {
  for (const error of [new Error("buffer limit"), new Error("timed out")]) {
    vi.mocked(runProcess).mockRejectedValueOnce(error);
    const result = await Effect.runPromise(Effect.result(inspectRemoteTerminalProcesses(target)));
    expect(result._tag).toBe("Failure");
  }
});

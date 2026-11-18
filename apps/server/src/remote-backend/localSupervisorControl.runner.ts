import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";
import type { ProcessRunOptions, ProcessRunResult } from "../utils/processRunner.ts";

// The group leader stays alive until its parent finishes draining output and kills the group.
// Holding that leader prevents its process-group ID being reused before cancellation. Scripts
// run in a subshell, so an internal exec/exit cannot bypass this ownership handshake. fd4 keeps
// large registry scripts out of argv, while fd0 remains the separate installer payload stream.
const CONTROL_SCRIPT = `
leader=$$
(
  exec 0<&- 1>&- 2>&- 4<&-
  read -r acknowledgement <&3 || :
  kill -KILL "-$leader"
) &
watchdog=$!
(
  exec 3>&-
  eval "$(cat <&4)"
)
status=$?
exec 1>&- 2>&-
printf '%s\\n' "$status" >&3
wait "$watchdog"
exit "$status"
`;
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;

/** Cancellable POSIX command group. Deliberate service launch must use a separate transport. */
export function runLocalSupervisorCommand(
  _command: string,
  args: ReadonlyArray<string>,
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  if (process.platform === "win32" || args[0] !== "-c" || args.length !== 2)
    return Promise.reject(new Error("Local supervisor control requires a POSIX sh -c command."));
  const script = args[1]!;
  if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES || script.includes("\0"))
    return Promise.reject(new Error("Local supervisor script exceeds the bounded control policy."));
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", CONTROL_SCRIPT], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    const control = child.stdio[3] as Duplex;
    const source = child.stdio[4] as Duplex;
    const output: Buffer[][] = [[], []];
    const counts = [0, 0];
    const ended = [false, false];
    let commandCode: number | undefined;
    let report = "";
    let failure: Error | undefined;
    let groupSignalled = false;
    let settled = false;
    let timedOut = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(cleanupTimer);
      options.signal?.removeEventListener("abort", abort);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      source.destroy();
      control.destroy();
      if (failure) return reject(failure);
      const result = {
        stdout: Buffer.concat(output[0]!).toString(),
        stderr: Buffer.concat(output[1]!).toString(),
        code: commandCode!,
        signal: null,
        timedOut,
      };
      if (commandCode !== 0)
        reject(
          new Error(
            `Local supervisor command failed (code=${commandCode}). ${result.stderr.trim()}`,
          ),
        );
      else resolve(result);
    };
    const endGroup = () => {
      if (groupSignalled) return;
      groupSignalled = true;
      if (child.pid !== undefined) {
        try {
          // One signal while the live group leader is held by the fd3 acknowledgement handshake.
          process.kill(-child.pid, "SIGKILL");
        } catch (cause) {
          failure ??= new Error("Local supervisor command-group cleanup could not be confirmed.", {
            cause,
          });
        }
      }
      // Broken inherited pipes cannot hold the caller forever after the owned group was killed.
      cleanupTimer = setTimeout(() => {
        failure ??= new Error("Local supervisor command-group reaping exceeded its deadline.");
        finish();
      }, 1000);
    };
    const fail = (error: Error) => {
      failure ??= error;
      endGroup();
    };
    const maybeDone = () => {
      if (commandCode !== undefined && ended.every(Boolean)) endGroup();
    };
    const abort = () => fail(new Error("Local supervisor command was cancelled."));
    const deadline = setTimeout(() => {
      timedOut = true;
      fail(new Error("Local supervisor command timed out."));
    }, options.timeoutMs ?? 60_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    [child.stdout!, child.stderr!].forEach((stream, index) => {
      stream.on("data", (chunk: Buffer) => {
        if (groupSignalled) return;
        counts[index]! += chunk.length;
        if (counts[index]! > (options.maxBufferBytes ?? 2 * 1024 * 1024))
          fail(new Error("Local supervisor command exceeded its output buffer limit."));
        else output[index]!.push(chunk);
      });
      stream.on("end", () => {
        ended[index] = true;
        maybeDone();
      });
      stream.on("error", (cause) => fail(new Error("Local supervisor output failed.", { cause })));
    });
    control.on("data", (chunk: Buffer) => {
      if (groupSignalled) return;
      report += chunk.toString();
      if (report.length > 32 || !/^\d{1,3}\n$/.test(report)) {
        if (report.length <= 3 && /^\d+$/.test(report)) return;
        fail(new Error("Local supervisor command ownership handshake was invalid."));
        return;
      }
      const code = Number(report.trim());
      if (code > 255) {
        fail(new Error("Invalid local supervisor exit code."));
        return;
      }
      commandCode = code;
      maybeDone();
    });
    source.on("error", (cause) => {
      if (!groupSignalled) fail(new Error("Local supervisor script delivery failed.", { cause }));
    });
    control.on("error", (cause) => {
      if (!groupSignalled) fail(new Error("Local supervisor ownership pipe failed.", { cause }));
    });
    child.stdin!.on("error", (cause) => {
      if (!groupSignalled) fail(new Error("Local supervisor payload delivery failed.", { cause }));
    });
    child.once("error", (cause) => {
      failure = new Error("Local supervisor command could not start.", { cause });
      finish();
    });
    child.once("close", () => {
      if (!groupSignalled)
        failure ??= new Error("Local supervisor command lost its ownership handshake.");
      finish();
    });
    source.end(script);
    child.stdin!.end(options.stdin ?? "");
  });
}

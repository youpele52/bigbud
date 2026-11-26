import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { platform } from "node:process";

import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.ts";
import { makePickerProofPipe, type PickerProofPipe } from "./sshOwnerPickerProof.pipe.ts";

// Leave time for the dispatcher to close the verified pipe and reap an owner
// finishing an in-flight operation (the native active reap budget is 13 seconds).
const EXIT_TIMEOUT_MS = 20_000;

/**
 * The native dispatcher is the named-pipe client. It retains the spawned owner's
 * handle and completes the verified bootstrap before forwarding any picker frames.
 * This side uses only the private stdio of the trusted dispatcher it spawned.
 */
export function spawnWindowsPickerProofPipe(
  binary: string,
  args: readonly string[],
): PickerProofPipe {
  if (platform !== "win32") throw new PickerProofOwnerError("ownerUnavailable");

  try {
    const child = spawn(binary, ["--windows-picker-dispatcher", ...args], {
      cwd: win32.dirname(binary),
      env: { BIGBUD_SSH_OWNER_PICKER_PROOF: "1" },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    const { stdin, stdout } = child;
    let stopped = false;
    let finished = false;
    let stopTimer: NodeJS.Timeout | undefined;
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        finished = true;
        if (stopTimer) clearTimeout(stopTimer);
        resolve();
      });
    });
    const pipe = makePickerProofPipe(stdin, stdout, () => {
      if (!stopped && !finished) {
        stopped = true;
        stopTimer = setTimeout(() => {
          stdin.destroy();
          stdout.destroy();
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, EXIT_TIMEOUT_MS);
        stopTimer.unref();
        stdin.end();
      }
      return closed;
    });
    child.on("error", pipe.lost);
    return pipe;
  } catch {
    throw new PickerProofOwnerError("ownerUnavailable");
  }
}

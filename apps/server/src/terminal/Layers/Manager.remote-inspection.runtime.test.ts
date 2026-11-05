import { expect, it } from "vitest";
import { runProcess } from "../../utils/processRunner.ts";
import {
  remoteInspectionInvocation,
  parseRemoteTerminalProcesses,
} from "./Manager.remote-inspection.ts";

/** Exercise the exact portable remote payload locally; no SSH connection or remote agent needed. */
it.skipIf(process.platform === "win32")(
  "runs the portable POSIX process snapshot on the host",
  async () => {
    const payload = remoteInspectionInvocation("ssh:host=fixture&auth=ssh-key").args.at(-1)!;
    const result = await runProcess("/bin/sh", ["-c", payload], {
      timeoutMs: 3000,
      settleOnTimeout: true,
      maxBufferBytes: 2 * 1024 * 1024,
    });
    const processes = parseRemoteTerminalProcesses(result.stdout);
    expect(processes.some((entry) => entry.pid === process.pid)).toBe(true);
  },
);

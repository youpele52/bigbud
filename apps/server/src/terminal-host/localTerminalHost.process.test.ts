import { describe, expect, it } from "vitest";

import {
  hasChildProcess,
  makeLocalTerminalHostProcesses,
  parsePsLstart,
  type ProcessCommandRunner,
} from "./localTerminalHost.process.ts";

const lstartRunner: ProcessCommandRunner = async () => ({
  stdout: "Sat Nov 21 10:00:05 2026\n",
  code: 0,
});

describe("local terminal host process verification", () => {
  it("parses C-locale ps lstart output as local time", () => {
    expect(parsePsLstart("Sat Nov 21 10:00:05 2026\n")).toBe(
      new Date(2026, 10, 21, 10, 0, 5).getTime(),
    );
    expect(parsePsLstart("Mon Jan  5 01:02:03 2026")).toBe(new Date(2026, 0, 5, 1, 2, 3).getTime());
    expect(parsePsLstart("sam 21 nov 10:00:05 2026")).toBeUndefined();
    expect(parsePsLstart("")).toBeUndefined();
  });

  it("verifies within 1 s, and reports a reused PID as a mismatch", async () => {
    const start = new Date(2026, 10, 21, 10, 0, 5).getTime();
    const processes = makeLocalTerminalHostProcesses(lstartRunner);
    expect(await processes.verify(4242, start + 400)).toBe("verified");
    expect(await processes.verify(4242, start + 5_000)).toBe("mismatch");
    expect(await processes.verify(undefined, start)).toBe("unknown");
    expect(await processes.verify(4242, undefined)).toBe("unknown");
  });

  it("distinguishes a missing process from a failed scan", async () => {
    const missing = makeLocalTerminalHostProcesses(async () => ({ stdout: "", code: 1 }));
    expect(await missing.verify(4242, 1)).toBe("not-running");
    const broken = makeLocalTerminalHostProcesses(async () => ({ stdout: "", code: null }));
    expect(await broken.verify(4242, 1)).toBe("unknown");
    // A failed child scan is never "no children".
    expect(await broken.hasChildren(4242)).toBeUndefined();
  });

  it("finds OS child processes from ps -A -o ppid=,pid=", () => {
    const output = "    1   100\n  100   200\n  300   301\n";
    expect(hasChildProcess(output, 100)).toBe(true);
    expect(hasChildProcess(output, 200)).toBe(false);
  });

  it("verifies this test process with the real ps", async () => {
    const processes = makeLocalTerminalHostProcesses();
    const start = await processes.startTime(process.pid);
    expect(typeof start).toBe("number");
    expect(await processes.verify(process.pid, start as number)).toBe("verified");
    expect(processes.isAlive(process.pid)).toBe(true);
  });
});

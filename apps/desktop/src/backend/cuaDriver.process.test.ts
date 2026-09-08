import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 81;
  child.kill = vi.fn(() => true);
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("cua-driver command quiescence", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.spawn.mockReset();
  });

  it("cancels and drains an in-flight probe while refusing new probes", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const commands = await import("./cuaDriver.process");
    const quiescence = await import("./installedProcessQuiescence");
    const running = commands.runCommand("/resources/cua-driver", ["status"]);

    quiescence.beginInstalledProcessQuiescence();
    const draining = commands.stopCuaDriverCommandsAndWait();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(() => commands.runCommand("/resources/cua-driver", ["status"])).toThrow(
      "cannot start while update installation is preparing",
    );

    child.exitCode = 0;
    child.emit("exit", 0, "SIGTERM");
    child.emit("close", 0, "SIGTERM");
    await expect(draining).resolves.toBeUndefined();
    await expect(running).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});

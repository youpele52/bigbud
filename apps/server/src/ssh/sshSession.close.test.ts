import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSshLocalCommand } from "./sshLocalCommand.ts";
import {
  buildPasswordSessionControlPath,
  closeSshPasswordSession,
  unlockSshExecutionTargetPassword,
} from "./sshSession.ts";
import {
  configureSshTargetDisconnects,
  isSshTargetDisconnected,
  markSshTargetDisconnected,
  RemoteTargetDisconnectedError,
} from "./sshTargetDisconnects.ts";

vi.mock("./sshLocalCommand.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sshLocalCommand.ts")>()),
  runSshLocalCommand: vi.fn(),
}));

vi.mock("./sshHostTrust.ts", () => ({ inspectSshHostTrust: vi.fn(async () => undefined) }));

const target = "ssh:host=box&user=root&port=2222&auth=password";
const succeeded = {
  status: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
} as Awaited<ReturnType<typeof runSshLocalCommand>>;

afterEach(() => configureSshTargetDisconnects(undefined, []));

describe("closeSshPasswordSession", () => {
  beforeEach(() => vi.resetAllMocks());

  it("asks the ControlMaster to exit, bounded, and removes its socket", async () => {
    const controlPath = buildPasswordSessionControlPath(target);
    fs.writeFileSync(controlPath, "");
    vi.mocked(runSshLocalCommand).mockResolvedValue(succeeded);

    await closeSshPasswordSession(target);

    expect(runSshLocalCommand).toHaveBeenCalledWith(
      "ssh",
      ["-O", "exit", "-o", `ControlPath=${controlPath}`, "-p", "2222", "root@box"],
      { timeoutMs: expect.any(Number) },
    );
    expect(fs.existsSync(controlPath)).toBe(false);
  });

  it("does nothing when no ControlMaster socket exists", async () => {
    await closeSshPasswordSession(target);
    await closeSshPasswordSession("local");
    expect(runSshLocalCommand).not.toHaveBeenCalled();
  });

  it("ends a master created by an unlock that a Disconnect overtook", async () => {
    const controlPath = buildPasswordSessionControlPath(target);
    vi.mocked(runSshLocalCommand).mockImplementation(async (_command, args) => {
      if (args.includes("-f")) {
        // The Disconnect lands while OpenSSH is authenticating the new master.
        await markSshTargetDisconnected(target);
        fs.writeFileSync(controlPath, "");
      }
      return succeeded;
    });

    await expect(
      unlockSshExecutionTargetPassword({ executionTargetId: target, password: "secret" }),
    ).rejects.toBeInstanceOf(RemoteTargetDisconnectedError);

    expect(isSshTargetDisconnected(target)).toBe(true);
    const exits = vi
      .mocked(runSshLocalCommand)
      .mock.calls.filter(([, args]) => args[0] === "-O" && args[1] === "exit");
    expect(exits).toHaveLength(1);
    expect(fs.existsSync(controlPath)).toBe(false);
  });
});

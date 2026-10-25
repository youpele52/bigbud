import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { inspectSshHostTrust } from "./sshHostTrust.ts";
import { runSshLocalCommand } from "./sshLocalCommand.ts";
import { unlockSshExecutionTargetPassword } from "./sshSession.ts";

vi.mock("./sshHostTrust.ts", () => ({ inspectSshHostTrust: vi.fn() }));
vi.mock("./sshLocalCommand.ts", async (original) => ({
  ...(await original<typeof import("./sshLocalCommand.ts")>()),
  runSshLocalCommand: vi.fn(),
}));

const target = "ssh:host=password-box&user=alice&auth=password";
describe.skipIf(process.platform === "win32")("password unlock host trust", () => {
  beforeEach(() => vi.resetAllMocks());

  it("does not start password authentication before host trust is approved", async () => {
    vi.mocked(inspectSshHostTrust).mockRejectedValue(
      new Error("SSH host trust is required: pending"),
    );
    await expect(
      unlockSshExecutionTargetPassword({ executionTargetId: target, password: "secret" }),
    ).rejects.toThrow(/host trust/);
    expect(runSshLocalCommand).not.toHaveBeenCalled();
  });

  it("refuses non-auth prompts and requires strict checking when it sends a password", async () => {
    vi.mocked(runSshLocalCommand).mockImplementationOnce(async (_command, args, options) => {
      expect(inspectSshHostTrust).toHaveBeenCalledWith(target);
      expect(args).toContain("StrictHostKeyChecking=yes");
      const execute = (prompt: string) =>
        spawnSync(options.env!.SSH_ASKPASS!, [prompt], { env: options.env, encoding: "utf8" });
      expect(execute("alice@password-box's password:").stdout).toBe("secret\n");
      const host = execute("The authenticity of host 'password-box' can't be established.");
      expect(host.status).toBe(1);
      expect(host.stdout).toBe("");
      expect(execute("Are you sure you want to continue connecting?").status).toBe(1);
      return { status: 255, stdout: "", stderr: "Permission denied", timedOut: false };
    });
    await expect(
      unlockSshExecutionTargetPassword({ executionTargetId: target, password: "secret" }),
    ).rejects.toThrow(/Incorrect password/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runProcess } from "../utils/processRunner.ts";
import { inspectSshHostTrust, inspectSshHostTrustOnFailure } from "./sshHostTrust.ts";
import { runSshCommand } from "./sshProcess.ts";
import { verifySshExecutionTarget } from "./sshVerification.ts";

vi.mock("../utils/processRunner.ts", () => ({ runProcess: vi.fn() }));
vi.mock("./sshHostTrust.ts", () => ({
  inspectSshHostTrust: vi.fn(),
  inspectSshHostTrustOnFailure: vi.fn(),
}));

const target = "ssh:host=box&auth=ssh-key";
describe("SSH setup host-trust routing", () => {
  beforeEach(() => vi.resetAllMocks());

  it("does not add a host identity probe to successful connections", async () => {
    vi.mocked(runProcess).mockResolvedValue({
      stdout: "/srv/app\n",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });
    await expect(verifySshExecutionTarget({ executionTargetId: target })).resolves.toHaveProperty(
      "cwd",
      "/srv/app",
    );
    expect(inspectSshHostTrust).not.toHaveBeenCalled();
    expect(inspectSshHostTrustOnFailure).not.toHaveBeenCalled();
  });

  it("routes verification failures through host-trust discovery", async () => {
    const failure = new Error("Host key verification failed.");
    vi.mocked(runProcess).mockRejectedValue(failure);
    vi.mocked(inspectSshHostTrustOnFailure).mockRejectedValue(
      new Error("SSH host trust is required: pending"),
    );
    await expect(verifySshExecutionTarget({ executionTargetId: target })).rejects.toThrow(
      /host trust/,
    );
    expect(inspectSshHostTrustOnFailure).toHaveBeenCalledWith(target, failure);
  });

  it("checks host trust before prompting for a first-time password", async () => {
    vi.mocked(inspectSshHostTrustOnFailure).mockRejectedValue(
      new Error("SSH host trust is required: pending"),
    );
    await expect(
      verifySshExecutionTarget({ executionTargetId: "ssh:host=box&auth=password" }),
    ).rejects.toThrow(/host trust/);
    expect(runProcess).not.toHaveBeenCalled();
    expect(inspectSshHostTrustOnFailure).toHaveBeenCalledWith(
      "ssh:host=box&auth=password",
      expect.objectContaining({ message: expect.stringContaining("SSH password is required") }),
    );
  });

  it("discovers trust failures even when folder browsing allows nonzero exits", async () => {
    vi.mocked(runProcess).mockResolvedValue({
      stdout: "",
      stderr: "Host key verification failed.",
      code: 255,
      signal: null,
      timedOut: false,
    });
    vi.mocked(inspectSshHostTrust).mockRejectedValue(
      new Error("SSH host trust is required: pending"),
    );
    await expect(
      runSshCommand({ executionTargetId: target, command: "sh", allowNonZeroExit: true }),
    ).rejects.toThrow(/host trust/);
    expect(inspectSshHostTrust).toHaveBeenCalledWith(target);
  });
});

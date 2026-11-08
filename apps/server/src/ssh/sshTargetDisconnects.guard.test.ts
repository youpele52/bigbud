import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runProcess } from "../utils/processRunner.ts";
import { remoteReadOnlyInvocation } from "../terminal/Layers/Manager.remote-inspection.ts";
import { buildSshCommandInvocation, buildSshTransportArgs } from "./sshCommand.ts";
import { inspectSshHostTrust } from "./sshHostTrust.ts";
import { runSshLocalCommand, runSshLocalCommandSync } from "./sshLocalCommand.ts";
import { runSshCommand } from "./sshProcess.ts";
import { unlockSshExecutionTargetPassword } from "./sshSession.ts";
import {
  configureSshTargetDisconnects,
  REMOTE_TARGET_DISCONNECTED_MESSAGE,
  RemoteTargetDisconnectedError,
} from "./sshTargetDisconnects.ts";
import {
  assertSshExecutionTargetReady,
  assertSshExecutionTargetReadyAsync,
  verifySshExecutionTarget,
} from "./sshVerification.ts";

vi.mock("../utils/processRunner.ts", () => ({ runProcess: vi.fn() }));
vi.mock("./sshLocalCommand.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sshLocalCommand.ts")>()),
  runSshLocalCommand: vi.fn(),
  runSshLocalCommandSync: vi.fn(),
}));

const keyTarget = "ssh:host=box&auth=ssh-key&keyPath=%2Fmissing%2Fid_ed25519";
const passwordTarget = "ssh:host=box&auth=password&port=2222";
const plainTarget = "ssh:host=box&auth=ssh-key";

function expectDisconnected(run: () => unknown) {
  expect(run).toThrow(RemoteTargetDisconnectedError);
}

describe("SSH disconnect guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configureSshTargetDisconnects(undefined, [keyTarget, passwordTarget]);
  });
  afterEach(() => configureSshTargetDisconnects(undefined, []));

  it("fails synchronous builders before any local probe", () => {
    expectDisconnected(() => buildSshTransportArgs({ executionTargetId: keyTarget }));
    expectDisconnected(() => buildSshTransportArgs({ executionTargetId: passwordTarget }));
    expectDisconnected(() =>
      buildSshCommandInvocation({ executionTargetId: passwordTarget, command: "pwd" }),
    );
    // The key path does not exist: a probe would report it instead of the disconnect.
    expectDisconnected(() => assertSshExecutionTargetReady(keyTarget));
    expectDisconnected(() => remoteReadOnlyInvocation(passwordTarget, "true"));
    expect(runSshLocalCommandSync).not.toHaveBeenCalled();
  });

  it("fails async readiness without probes or a host-trust prompt", async () => {
    await expect(assertSshExecutionTargetReadyAsync(passwordTarget)).rejects.toBeInstanceOf(
      RemoteTargetDisconnectedError,
    );
    await expect(verifySshExecutionTarget({ executionTargetId: keyTarget })).rejects.toThrow(
      REMOTE_TARGET_DISCONNECTED_MESSAGE,
    );
    await expect(
      runSshCommand({ executionTargetId: passwordTarget, command: "pwd" }),
    ).rejects.toBeInstanceOf(RemoteTargetDisconnectedError);
    await expect(inspectSshHostTrust(passwordTarget)).rejects.toBeInstanceOf(
      RemoteTargetDisconnectedError,
    );
    await expect(
      unlockSshExecutionTargetPassword({ executionTargetId: passwordTarget, password: "secret" }),
    ).rejects.toBeInstanceOf(RemoteTargetDisconnectedError);
    expect(runSshLocalCommand).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("leaves connected targets on their normal path", async () => {
    expect(buildSshTransportArgs({ executionTargetId: plainTarget })).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
    ]);
    expect(remoteReadOnlyInvocation(plainTarget, "true").args.at(-1)).toBe("true");
    await expect(assertSshExecutionTargetReadyAsync(plainTarget)).resolves.toBeUndefined();
    vi.mocked(runProcess).mockResolvedValue({
      stdout: "/srv\n",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });
    await expect(
      runSshCommand({ executionTargetId: plainTarget, command: "pwd" }),
    ).resolves.toMatchObject({ stdout: "/srv\n" });
    expect(runProcess).toHaveBeenCalledOnce();
  });
});

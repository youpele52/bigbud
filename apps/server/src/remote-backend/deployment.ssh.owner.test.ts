import { afterEach, describe, expect, it, vi } from "vitest";

import { assertSshExecutionTargetReadyAsync } from "../ssh/sshVerification.ts";
import {
  graphInstallName,
  GRAPH_STAGE_SCRIPT,
  stageRemoteBackendGraph,
} from "./deployment.fetch.ts";
import {
  probeRemoteBackendHost,
  readRemoteSetupCompletion,
  REMOTE_PROBE_SCRIPT,
  SSH_HOST_KEY_DIR,
} from "./deployment.remoteSetup.ts";
import type { DeploymentSshOwner } from "./deployment.ssh.owner.ts";
import { makeDeploymentSshRunner, runDeploymentSsh } from "./deployment.ssh.ts";
import { makeDeploymentFixture } from "./deployment.test.helpers.ts";
import type { DeploymentRemoteCommand } from "./deployment.types.ts";

vi.mock("../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReadyAsync: vi.fn(async () => {
    throw new Error("Legacy SSH was used by an owner-selected runner");
  }),
}));

afterEach(() => {
  expect(assertSshExecutionTargetReadyAsync).not.toHaveBeenCalled();
});

const target = "ssh:host=vps&user=deploy&port=2202&auth=ssh-key";
const requestId = "3baaeec7-e811-40a3-bf2b-09608f12f1ec";
const hostDigest = "a".repeat(64);
const authorityId = "b".repeat(32);
const probeCommand = {
  command: "/bin/sh",
  args: ["-c", REMOTE_PROBE_SCRIPT, "sh", requestId, SSH_HOST_KEY_DIR],
  timeoutMs: 30_000,
} satisfies DeploymentRemoteCommand;
const archiveSha256 = "c".repeat(64);
const manifestSha256 = "d".repeat(64);
const installName = `1.2.3-beta+dev-aarch64-unknown-linux-gnu-${archiveSha256.slice(0, 16)}`;
const stageCommand = {
  command: "/bin/sh",
  args: [
    "-c",
    GRAPH_STAGE_SCRIPT,
    "sh",
    "begin",
    requestId,
    installName,
    archiveSha256,
    manifestSha256,
  ],
  timeoutMs: 60_000,
} satisfies DeploymentRemoteCommand;
const staged = { kind: "exited", code: 0, stdout: "staged\n", stderr: "" } as const;

function stagingFixture() {
  const beginGraphStage = vi
    .fn<NonNullable<DeploymentSshOwner["beginGraphStage"]>>()
    .mockResolvedValue(staged);
  return { ...fixture(beginGraphStage), beginGraphStage };
}

const exited = {
  kind: "exited",
  code: 0,
  stdout: `home=/home/deploy\narch=aarch64\nhost=${hostDigest}\ncompleted=${authorityId}\n`,
  stderr: "",
} as const;

function fixture(beginGraphStage?: DeploymentSshOwner["beginGraphStage"]) {
  const deploymentAction = vi
    .fn<DeploymentSshOwner["deploymentAction"]>()
    .mockResolvedValue(exited);
  const runner = makeDeploymentSshRunner({
    kind: "owner",
    owner: { deploymentAction, ...(beginGraphStage ? { beginGraphStage } : {}) },
  });
  const controller = new AbortController();
  return { deploymentAction, runner, controller, signal: controller.signal };
}

describe("deployment SSH graph stage begin", () => {
  it("dispatches the exact legacy begin call with typed operands and preserves graph reuse", async () => {
    const { runner, beginGraphStage, deploymentAction, signal } = stagingFixture();
    beginGraphStage.mockResolvedValueOnce({ ...staged, stdout: "present\n" });
    const local = await makeDeploymentFixture();
    try {
      const source = await local.graph("1.2.3-beta+dev");
      const installName = graphInstallName(source);
      await expect(
        stageRemoteBackendGraph({
          executionTargetId: target,
          requestId,
          remoteHome: local.home,
          source,
          run: runner,
          signal,
        }),
      ).resolves.toMatchObject({
        reused: true,
        installDir: `${local.home}/.bigbud/backend-graphs/${installName}`,
      });
      expect(beginGraphStage.mock.calls).toStrictEqual([
        [
          {
            executionTargetId: target,
            action: {
              kind: "beginGraphStage",
              requestId,
              installName,
              archiveSha256: source.archiveSha256,
              manifestSha256: source.manifestSha256,
            },
          },
          signal,
        ],
      ]);
      expect(deploymentAction).not.toHaveBeenCalled();
      expect(local.calls).toHaveLength(0);
    } finally {
      await local.cleanup();
    }
  });

  it("passes through a staged result and a confirmed nonzero exit", async () => {
    const { runner, beginGraphStage, signal } = stagingFixture();
    await expect(runner(target, stageCommand, signal)).resolves.toEqual({
      code: 0,
      stdout: "staged\n",
      stderr: "",
    });
    beginGraphStage.mockResolvedValueOnce({ ...staged, code: 73, stdout: "" });
    await expect(runner(target, stageCommand, signal)).resolves.toEqual({
      code: 73,
      stdout: "",
      stderr: "",
    });
    expect(beginGraphStage).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...stageCommand, command: "/bin/bash" },
    { ...stageCommand, args: stageCommand.args.with(1, `${GRAPH_STAGE_SCRIPT}\n`) },
    { ...stageCommand, args: stageCommand.args.with(2, "bash") },
    ...["put", "put-input", "fetch-url", "fetch-stdin", "commit", "cleanup"].map((op) => ({
      command: stageCommand.command,
      args: stageCommand.args.with(3, op),
      timeoutMs: stageCommand.timeoutMs,
    })),
    { ...stageCommand, args: stageCommand.args.slice(0, -1) },
    { ...stageCommand, args: [...stageCommand.args, "extra"] },
    { ...stageCommand, env: {} },
    { ...stageCommand, stdin: { text: "" } },
    { ...stageCommand, stdin: { path: "/tmp/archive" } },
    { ...stageCommand, timeoutMs: 60_001 },
  ] satisfies DeploymentRemoteCommand[])(
    "refuses a command outside the fixed begin shape (%#)",
    async (command) => {
      const { runner, beginGraphStage, deploymentAction, signal } = stagingFixture();
      await expect(runner(target, command, signal)).rejects.toMatchObject({ code: "unavailable" });
      expect(beginGraphStage).not.toHaveBeenCalled();
      expect(deploymentAction).not.toHaveBeenCalled();
    },
  );

  it.each([
    [4, "../../another-request"],
    [5, `../${installName}`],
    [5, `${"v".repeat(65)}-aarch64-unknown-linux-gnu-${archiveSha256.slice(0, 16)}`],
    [5, installName.replace("aarch64", "bogus")],
    [5, `${installName}\n`],
    [6, "d".repeat(64)],
    [6, archiveSha256.toUpperCase()],
    [7, manifestSha256.slice(1)],
  ] as const)("rejects invalid staging operand at index %i (%#)", async (index, value) => {
    const { runner, beginGraphStage, signal } = stagingFixture();
    await expect(
      runner(target, { ...stageCommand, args: stageCommand.args.with(index, value) }, signal),
    ).rejects.toMatchObject({ code: "invalid-target" });
    expect(beginGraphStage).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "failed", reason: "approval-refused" },
    { kind: "failed", reason: "trust-refused" },
    { kind: "failed", reason: "unsupported" },
    { kind: "failed", reason: "timeout" },
    { kind: "failed", reason: "unavailable" },
    { kind: "failed", reason: "output-limit" },
    { ...staged, code: 255 },
    { ...staged, stdout: "" },
    { ...staged, stdout: "é".repeat(513) },
    { ...staged, stderr: "é".repeat(8193) },
  ] as const)(
    "rejects stage refusal, uncertain delivery or invalid output (%#) without retry",
    async (result) => {
      const { runner, beginGraphStage, deploymentAction, signal } = stagingFixture();
      beginGraphStage.mockResolvedValueOnce(result);
      await expect(runner(target, stageCommand, signal)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(beginGraphStage).toHaveBeenCalledTimes(1);
      expect(deploymentAction).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch an invalid target or an aborted stage, or accept a late result", async () => {
    const { runner, beginGraphStage, controller, signal } = stagingFixture();
    const reason = new Error("Deployment stopped");
    await expect(runner("local", stageCommand, signal)).rejects.toMatchObject({
      code: "invalid-target",
    });
    await expect(runner(target, stageCommand, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(beginGraphStage).not.toHaveBeenCalled();
    beginGraphStage.mockImplementationOnce(async (_request, ownerSignal) => {
      expect(ownerSignal).toBe(signal);
      controller.abort(reason);
      return staged;
    });
    await expect(runner(target, stageCommand, signal)).rejects.toBe(reason);
    expect(beginGraphStage).toHaveBeenCalledTimes(1);
  });
});

describe("deployment SSH owner selection", () => {
  it("keeps the current SSH process runner as the default", () => {
    expect(makeDeploymentSshRunner()).toBe(runDeploymentSsh);
    expect(makeDeploymentSshRunner({ kind: "legacy" })).toBe(runDeploymentSsh);
  });

  it("sends only exact target and probe operand, keeping host and completion identities separate", async () => {
    const { runner, deploymentAction, signal } = fixture();
    await expect(probeRemoteBackendHost(runner, target, requestId, signal)).resolves.toEqual({
      home: "/home/deploy",
      target: "aarch64-unknown-linux-gnu",
      hostIdentity: `sha256:${hostDigest}`,
      completedAuthorityId: authorityId,
    });
    expect(deploymentAction.mock.calls).toStrictEqual([
      [{ executionTargetId: target, action: { kind: "probeHost", requestId } }, signal],
    ]);
  });

  it.each([
    ["another executable", { ...probeCommand, command: "/bin/bash" }],
    [
      "another script",
      { ...probeCommand, args: ["-c", "true", "sh", requestId, SSH_HOST_KEY_DIR] },
    ],
    [
      "another host key directory",
      { ...probeCommand, args: ["-c", REMOTE_PROBE_SCRIPT, "sh", requestId, "/tmp"] },
    ],
    ["an extra operand", { ...probeCommand, args: [...probeCommand.args, "extra"] }],
    ["an environment", { ...probeCommand, env: {} }],
    ["text stdin", { ...probeCommand, stdin: { text: "" } }],
    ["file stdin", { ...probeCommand, stdin: { path: "/tmp/archive" } }],
    ["another deadline", { ...probeCommand, timeoutMs: 30_001 }],
    [
      "graph staging",
      {
        command: "/bin/sh",
        args: ["-c", GRAPH_STAGE_SCRIPT, "sh", "begin", requestId],
        timeoutMs: 60_000,
      },
    ],
  ] as const)("refuses %s before owner or legacy dispatch", async (_label, command) => {
    const { runner, deploymentAction, signal } = fixture();
    await expect(runner(target, command, signal)).rejects.toMatchObject({
      _tag: "RemoteBackendDeploymentError",
      code: "unavailable",
      message: expect.stringContaining("not supported"),
    });
    expect(deploymentAction).not.toHaveBeenCalled();
  });

  it("cannot switch transport for a later unsupported step after a successful host probe", async () => {
    const { runner, deploymentAction, signal } = fixture();
    await probeRemoteBackendHost(runner, target, requestId, signal);
    await expect(runner(target, stageCommand, signal)).rejects.toMatchObject({
      code: "unavailable",
      message: "The SSH owner does not support beginning graph staging.",
    });
    expect(deploymentAction).toHaveBeenCalledTimes(1);
  });

  it("sends both completion correlation operands through the selected port", async () => {
    const { runner, deploymentAction, signal } = fixture();
    await expect(
      readRemoteSetupCompletion({
        run: runner,
        executionTargetId: target,
        requestId,
        authorityId,
        signal,
      }),
    ).rejects.toMatchObject({ code: "setup-failed" });
    expect(deploymentAction.mock.calls).toStrictEqual([
      [
        { executionTargetId: target, action: { kind: "readCompletion", requestId, authorityId } },
        signal,
      ],
    ]);
  });

  it("refuses invalid targets and request IDs before dispatch", async () => {
    const { runner, deploymentAction, signal } = fixture();
    await expect(runner("local", probeCommand, signal)).rejects.toMatchObject({
      code: "invalid-target",
    });
    await expect(
      probeRemoteBackendHost(runner, target, "invalid-id", signal),
    ).rejects.toMatchObject({ code: "invalid-target" });
    expect(deploymentAction).not.toHaveBeenCalled();
  });

  it.each([
    "approval-refused",
    "trust-refused",
    "unsupported",
    "timeout",
    "output-limit",
    "unavailable",
  ] as const)("maps owner %s to a typed deployment error without retry", async (reason) => {
    const { runner, deploymentAction, signal } = fixture();
    deploymentAction.mockResolvedValueOnce({ kind: "failed", reason });
    await expect(probeRemoteBackendHost(runner, target, requestId, signal)).rejects.toMatchObject({
      _tag: "RemoteBackendDeploymentError",
      code: "unavailable",
    });
    expect(deploymentAction).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary process exits and existing probe errors distinct from owner loss", async () => {
    const { runner, deploymentAction, signal } = fixture();
    deploymentAction.mockResolvedValueOnce({ ...exited, code: 70 });
    await expect(runner(target, probeCommand, signal)).resolves.toMatchObject({ code: 70 });
    deploymentAction.mockResolvedValueOnce({ ...exited, stdout: "" });
    await expect(probeRemoteBackendHost(runner, target, requestId, signal)).rejects.toMatchObject({
      code: "unsupported-host",
    });
    deploymentAction.mockRejectedValueOnce(new Error("private owner detail"));
    await expect(probeRemoteBackendHost(runner, target, requestId, signal)).rejects.toMatchObject({
      code: "unavailable",
      message: "The SSH owner could not complete the remote host probe.",
    });
    expect(deploymentAction).toHaveBeenCalledTimes(3);
  });

  it.each([
    { ...exited, code: 255 },
    { ...exited, stdout: "é".repeat(128 * 1024 + 1) },
    { ...exited, stderr: "é".repeat(8 * 1024 + 1) },
  ])("rejects a reserved exit status or over-limit bytes", async (result) => {
    const { runner, deploymentAction, signal } = fixture();
    deploymentAction.mockResolvedValueOnce(result);
    await expect(runner(target, probeCommand, signal)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(deploymentAction).toHaveBeenCalledTimes(1);
  });

  it("does not start an aborted operation or accept a late result after abort", async () => {
    const { runner, deploymentAction, controller, signal } = fixture();
    const canceled = new Error("Deployment service stopped");
    await expect(runner(target, probeCommand, AbortSignal.abort(canceled))).rejects.toBe(canceled);
    expect(deploymentAction).not.toHaveBeenCalled();
    deploymentAction.mockImplementationOnce(async (_request, ownerSignal) => {
      expect(ownerSignal).toBe(signal);
      controller.abort(canceled);
      return exited;
    });
    await expect(runner(target, probeCommand, signal)).rejects.toBe(canceled);
    expect(deploymentAction).toHaveBeenCalledTimes(1);
  });
});

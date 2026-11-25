import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { RemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import {
  RemoteAgentRemoteCommandError,
  runRemoteAgentDiagnosedCommand,
  sanitizeRemoteAgentStderr,
} from "./remoteAgentDiagnostics.ts";
import type { RemoteAgentCommandRunner } from "./remoteAgentCommand.types.ts";
import { probeRemoteAgentPlacedArtifact } from "./remoteAgentInstall.inbox.ts";
import {
  REMOTE_AGENT_AGENT_ARTIFACT_LIMIT_BYTES,
  runRemoteAgentAgentOperation,
  validateRemoteAgentAgentOperation,
  type RemoteAgentAgentOperationRunner,
} from "./remoteAgentAgentAction.ts";

const converted = [
  "remoteAgentDiagnostics.ts",
  "remoteAgentInstall.inbox.ts",
  "remoteAgentInstall.transaction.ts",
  "remoteAgentLocalControl.approval.ts",
] as const;

/** D5 reuses the same shape for local supervisor control in another package area. */
const localSupervisorInstaller = new URL(
  "../remote-backend/localSupervisorInstaller.ts",
  import.meta.url,
);

const operationId = new Uint8Array(32);
const okRun: RemoteAgentCommandRunner = async () => ({
  stdout: "ok",
  stderr: "warn",
  code: 0,
  timedOut: false,
});
const placedRun: RemoteAgentCommandRunner = async () => ({
  stdout: "managed",
  stderr: "",
  code: 0,
  timedOut: false,
});

const artifact: RemoteAgentArtifact = {
  version: "0.3.3",
  buildDigest: "digest",
  protocolMajor: 1,
  protocolMinor: 9,
  targetTriple: "aarch64-unknown-linux-gnu",
  sizeBytes: 8,
  sha256: "a".repeat(64),
  signature: { algorithm: "ed25519", keyId: "release", value: "sig" },
};

describe("D1-D5 no longer depend on the legacy SSH process type", () => {
  it.each(converted)("%s imports the local bounded contract only", (file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).not.toMatch(/sshProcess/);
    expect(source).not.toMatch(/RunSshCommandInput/);
  });

  it("D5 declares its own bounded command envelope and never imports the SSH process", () => {
    const source = readFileSync(localSupervisorInstaller, "utf8");
    expect(source).not.toMatch(/sshProcess/);
    expect(source).not.toMatch(/RunSshCommandInput/);
    expect(source).toMatch(/export interface LocalSupervisorCommandEnvelope/);
  });

  it("declares the local bounded command contract", () => {
    const source = readFileSync(new URL("remoteAgentCommand.types.ts", import.meta.url), "utf8");
    expect(source).toMatch(/export interface RemoteAgentCommandRequest/);
    expect(source).toMatch(/export type RemoteAgentCommandRunner/);
  });

  it("keeps the diagnosed command behavior behind the local runner", async () => {
    await expect(
      runRemoteAgentDiagnosedCommand(okRun, "preflight", {
        executionTargetId: "ssh:agent:converted",
        command: "sh",
        args: ["-c", "printf ok"],
      }),
    ).resolves.toEqual({ stdout: "ok", stderr: "warn" });

    await expect(
      runRemoteAgentDiagnosedCommand(
        async () => ({
          stdout: "",
          stderr: "fatal: token=super-secret-value",
          code: 2,
          timedOut: false,
        }),
        "control",
        { executionTargetId: "ssh:agent:converted", command: "sh" },
      ),
    ).rejects.toMatchObject({
      stage: "control",
      exitCode: 2,
      stderrTail: sanitizeRemoteAgentStderr("fatal: token=super-secret-value"),
    });
  });

  it("reads placed artifacts through the local runner", async () => {
    await expect(
      probeRemoteAgentPlacedArtifact(placedRun, "ssh:agent:converted", artifact),
    ).resolves.toBe("managed");
  });
});

describe("typed agent operations", () => {
  const operation = {
    executionTargetId: "ssh:agent:converted",
    action: "status",
    operationId,
  } as const;

  it("refuses caller-supplied artifact bytes on a read-only verb", () => {
    expect(() =>
      validateRemoteAgentAgentOperation({
        ...operation,
        artifact: {
          version: "0.3.3",
          sha256: "a".repeat(64),
          size: 1,
          targetTriple: "aarch64-unknown-linux-gnu",
          bytes: Uint8Array.of(0),
        },
      }),
    ).toThrow();
  });

  it("refuses oversize install artifacts before dispatch", () => {
    const size = REMOTE_AGENT_AGENT_ARTIFACT_LIMIT_BYTES + 1;
    expect(() =>
      validateRemoteAgentAgentOperation({
        executionTargetId: "ssh:agent:converted",
        action: "install",
        operationId,
        artifact: {
          version: "0.3.3",
          sha256: "a".repeat(64),
          size,
          targetTriple: "aarch64-unknown-linux-gnu",
          bytes: new Uint8Array(size),
        },
      }),
    ).toThrow();
  });

  const result = (patch: Partial<Awaited<ReturnType<RemoteAgentAgentOperationRunner>>>) => ({
    action: "status" as const,
    operationId,
    exitCode: 0 as number | undefined,
    stdout: "absent",
    stderr: "",
    truncated: false,
    outcomeUnknown: false,
    reattached: false,
    ...patch,
  });

  it("passes bounded streams through unchanged", async () => {
    await expect(
      runRemoteAgentAgentOperation(async () => result({ stderr: "warn" }), operation, "control"),
    ).resolves.toEqual({ stdout: "absent", stderr: "warn" });
  });

  it("reports a partial or lost result as typed and never retries", async () => {
    let calls = 0;
    const runner: RemoteAgentAgentOperationRunner = async () => {
      calls += 1;
      return result({
        action: "install",
        exitCode: undefined,
        outcomeUnknown: true,
        stderr: "bigbud-install: partial",
      });
    };
    await expect(
      runRemoteAgentAgentOperation(
        runner,
        {
          executionTargetId: "ssh:agent:converted",
          action: "install",
          operationId,
          artifact: {
            version: "0.3.3",
            sha256: "a".repeat(64),
            size: 1,
            targetTriple: "aarch64-unknown-linux-gnu",
            bytes: Uint8Array.of(0),
          },
        },
        "install",
      ),
    ).rejects.toBeInstanceOf(RemoteAgentRemoteCommandError);
    expect(calls).toBe(1);
  });

  it("keeps stdout and stderr separate on failure", async () => {
    await expect(
      runRemoteAgentAgentOperation(
        async () => result({ exitCode: 3, stdout: "out", stderr: "err" }),
        operation,
        "control",
      ),
    ).rejects.toMatchObject({ stage: "control", exitCode: 3, stderrTail: "err" });
  });
});

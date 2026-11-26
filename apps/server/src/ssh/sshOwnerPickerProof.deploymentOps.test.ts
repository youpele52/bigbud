import { describe, expect, it, vi } from "vitest";

import {
  MAX_DEPLOYMENT_ARCHIVE_BYTES,
  MAX_DEPLOYMENT_PINS,
  type DeploymentStepOutcome,
  type DeploymentStepRequest,
} from "../remote-backend/deployment.ssh.owner.operations.ts";
import {
  makeOwnedDeploymentSshRunner,
  type OwnedDeploymentRemoteRunner,
} from "../remote-backend/deployment.ssh.owner.ts";
import { decodeMessage, WireReader } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { encodeRequest } from "./sshOwnerPickerProof.codec.ts";

const target = "ssh:host=vps&user=deploy&port=2202&auth=ssh-key";
const requestId = "3baaeec7-e811-40a3-bf2b-09608f12f1ec";
const installName = `1.2.3-aarch64-unknown-linux-gnu-${"a".repeat(16)}`;
const archiveSha256 = "a".repeat(64);
const manifestSha256 = "b".repeat(64);
const pins = [{ path: "bin/node", sha256: "c".repeat(64) }];
const signal = () => new AbortController().signal;

function completed(request: DeploymentStepRequest): DeploymentStepOutcome {
  return {
    requestId: request.requestId,
    action: request.action,
    exitCode: 0,
    stdout: `${request.action}-done\n`,
    stderr: "",
    state: "completed",
    outcomeUnknown: false,
    reattached: false,
  };
}

/** Faithful owner semantics: retain one operation per request id and never replay it. */
function owner(behave: (request: DeploymentStepRequest) => DeploymentStepOutcome = completed) {
  const retained = new Map<string, DeploymentStepOutcome>();
  const calls: DeploymentStepRequest[] = [];
  const deploymentStep = vi.fn(async (request: DeploymentStepRequest, ownerSignal: AbortSignal) => {
    ownerSignal.throwIfAborted();
    calls.push(request);
    const prior = retained.get(request.requestId);
    if (request.action === "reattach") {
      if (!prior) throw new Error("No retained deployment operation.");
      return { ...prior, reattached: true };
    }
    if (request.action === "cancel") {
      if (!prior) throw new Error("No retained deployment operation.");
      const cancelled = { ...prior, state: "cancelled" as const, outcomeUnknown: false };
      retained.set(request.requestId, cancelled);
      return cancelled;
    }
    if (prior && prior.state !== "started") return prior;
    const outcome = behave(request);
    retained.set(request.requestId, outcome);
    return outcome;
  });
  const runner = makeOwnedDeploymentSshRunner({
    deploymentAction: vi.fn(),
    deploymentStep,
  }) as OwnedDeploymentRemoteRunner & {
    runDeploymentStep: NonNullable<OwnedDeploymentRemoteRunner["runDeploymentStep"]>;
    cancelDeploymentOperation: NonNullable<
      OwnedDeploymentRemoteRunner["cancelDeploymentOperation"]
    >;
    reattachDeploymentOperation: NonNullable<
      OwnedDeploymentRemoteRunner["reattachDeploymentOperation"]
    >;
  };
  return { calls, deploymentStep, runner, retained };
}

const publish: DeploymentStepRequest = {
  executionTargetId: target,
  action: "publish",
  requestId,
  installName,
  archiveSha256,
  manifestSha256,
  nodePath: "bin/node",
  entryPath: "app/entry.mjs",
  pins,
};

describe("typed deployment steps", () => {
  it.each([
    ["reset", { ...publish, action: "reset" as const }],
    [
      "fetch",
      {
        ...publish,
        action: "fetch" as const,
        url: "https://updates.invalid/graph.tar.gz",
        maxBytes: 1024,
      },
    ],
    ["publish", publish],
    [
      "start",
      {
        ...publish,
        action: "start" as const,
        authorityId: "d".repeat(32),
        enableBoot: true,
      },
    ],
  ] satisfies Array<[string, DeploymentStepRequest]>)(
    "dispatches %s with its exact bounded operands",
    async (_label, request) => {
      const { calls, runner } = owner();
      await expect(runner.runDeploymentStep(request, signal())).resolves.toMatchObject({
        action: request.action,
        state: "completed",
        exitCode: 0,
        reattached: false,
      });
      expect(calls).toStrictEqual([request]);
    },
  );

  it("refuses an oversize archive upload before any owner dispatch", async () => {
    const { deploymentStep, runner } = owner();
    await expect(
      runner.runDeploymentStep(
        {
          executionTargetId: target,
          action: "archiveUpload",
          requestId,
          archiveSha256,
          contents: new Uint8Array(MAX_DEPLOYMENT_ARCHIVE_BYTES + 1),
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid-target" });
    await expect(
      runner.runDeploymentStep(
        {
          executionTargetId: target,
          action: "archiveUpload",
          requestId,
          archiveSha256,
          contents: new Uint8Array(0),
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid-target" });
    expect(deploymentStep).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a non-https asset",
      { ...publish, action: "fetch" as const, url: "http://x.invalid/a", maxBytes: 1 },
    ],
    [
      "an unbounded fetch",
      { ...publish, action: "fetch" as const, url: "https://x.invalid/a", maxBytes: 0 },
    ],
    [
      "too many pins",
      { ...publish, pins: Array.from({ length: MAX_DEPLOYMENT_PINS + 1 }, () => pins[0]!) },
    ],
    ["a graph escape", { ...publish, nodePath: "../../bin/sh" }],
    [
      "a malformed install name",
      { ...publish, installName: "1.2.3-aarch64-unknown-linux-gnu-short" },
    ],
    [
      "an invalid authority",
      { ...publish, action: "start" as const, authorityId: "nope", enableBoot: false },
    ],
    [
      "a missing boot consent",
      { ...publish, action: "start" as const, authorityId: "d".repeat(32) },
    ],
  ])("refuses %s", async (_label, request) => {
    const { deploymentStep, runner } = owner();
    await expect(runner.runDeploymentStep(request, signal())).rejects.toMatchObject({
      code: "invalid-target",
    });
    expect(deploymentStep).not.toHaveBeenCalled();
  });
});

describe("deployment operation cancellation and unknown outcomes", () => {
  it("cancels exactly one operation lease and leaves the sibling retained", async () => {
    const { calls, runner } = owner();
    await runner.runDeploymentStep(publish, signal());
    const sibling = { ...publish, requestId: "0f0e0d0c-0b0a-4b4a-8988-877665544332" };
    await runner.runDeploymentStep(sibling, signal());

    const cancelled = await runner.cancelDeploymentOperation(target, requestId, signal());
    expect(cancelled).toMatchObject({ requestId, action: "cancel", state: "cancelled" });
    expect(calls.at(-1)).toStrictEqual({
      executionTargetId: target,
      requestId,
      action: "cancel",
    });

    await expect(
      runner.reattachDeploymentOperation(target, requestId, signal()),
    ).resolves.toMatchObject({ state: "cancelled", reattached: true });
    await expect(
      runner.reattachDeploymentOperation(target, sibling.requestId, signal()),
    ).resolves.toMatchObject({ state: "completed", reattached: true });
  });

  it("refuses an unknown operation id instead of running it", async () => {
    const { deploymentStep, runner } = owner();
    await expect(
      runner.cancelDeploymentOperation(target, requestId, signal()),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      runner.reattachDeploymentOperation(target, requestId, signal()),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(deploymentStep).toHaveBeenCalledTimes(2);
    expect(deploymentStep.mock.calls.every(([request]) => request.action !== "publish")).toBe(true);
  });

  it("reports an unconfirmed mutation once, never replays it, and reattaches it by id", async () => {
    const { deploymentStep, runner } = owner((request) => ({
      requestId: request.requestId,
      action: request.action,
      exitCode: undefined,
      stdout: "",
      stderr: "",
      state: "outcomeUnknown",
      outcomeUnknown: true,
      reattached: false,
    }));
    await expect(runner.runDeploymentStep(publish, signal())).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("not replayed"),
    });
    expect(deploymentStep).toHaveBeenCalledTimes(1);

    await expect(
      runner.reattachDeploymentOperation(target, requestId, signal()),
    ).resolves.toMatchObject({ state: "outcomeUnknown", reattached: true });
    expect(deploymentStep).toHaveBeenCalledTimes(2);
    // Reattach reads the retained record; it never dispatches the step again.
    expect(deploymentStep.mock.calls[1]?.[0]).toMatchObject({ action: "reattach" });
  });

  it("does not dispatch or cancel after the caller is already cancelled", async () => {
    const { deploymentStep, runner } = owner();
    const cancelled = new Error("Deployment stopped");
    await expect(runner.runDeploymentStep(publish, AbortSignal.abort(cancelled))).rejects.toBe(
      cancelled,
    );
    await expect(
      runner.cancelDeploymentOperation(target, requestId, AbortSignal.abort(cancelled)),
    ).rejects.toBe(cancelled);
    expect(deploymentStep).not.toHaveBeenCalled();
  });
});

describe("deployment action wire fields", () => {
  const operation = (action: "archiveUpload" | "publish" | "cancel" | "reattach") => {
    const bytes = encodeRequest({
      requestId: new Uint8Array(2),
      ownerEpoch: new Uint8Array(1),
      generation: new Uint8Array(1),
      targetId: "fixture-target",
      operation: {
        kind: "proofDeploymentAction",
        action,
        requestId,
        ...(action === "archiveUpload"
          ? { archiveSha256, contents: Uint8Array.of(7) }
          : action === "publish"
            ? {
                installName,
                archiveSha256,
                manifestSha256,
                nodePath: "bin/node",
                entryPath: "app/entry.mjs",
                pins,
              }
            : {}),
      },
    });
    const fields = new Map<number, Uint8Array>();
    decodeMessage(bytes, (field, _wire, reader) => void fields.set(field, reader.bytesValue()));
    const request = fields.get(5)!;
    const operationBytes = new Map<number, Uint8Array>();
    decodeMessage(
      request,
      (field, _wire, reader) => void operationBytes.set(field, reader.bytesValue()),
    );
    return operationBytes.get(73)!;
  };

  const kinds = (bytes: Uint8Array) => {
    const values = new Map<number, number>();
    const reader = new WireReader(bytes);
    while (!reader.done) {
      const { field, wireType } = reader.tag();
      if (wireType === 0) values.set(field, reader.uint());
      else values.set(field, reader.bytesValue().length);
    }
    return values;
  };

  it.each([
    ["archiveUpload", 1],
    ["publish", 4],
    ["cancel", 6],
    ["reattach", 7],
  ] as const)("encodes %s as deployment action kind %i at field 73", (action, kind) => {
    expect(kinds(operation(action)).get(2)).toBe(kind);
  });

  it("keeps upload bytes and publication pins inside their bounded messages", () => {
    const upload = kinds(operation("archiveUpload"));
    expect(upload.get(4)).toBe(64);
    expect(upload.get(8)).toBe(1);
    const published = kinds(operation("publish"));
    expect(published.get(11)).toBe("bin/node".length);
    expect(published.get(12)).toBe("app/entry.mjs".length);
    expect(published.get(13)).toBeGreaterThan(0);
  });
});

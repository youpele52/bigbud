import { ServerListRemoteFoldersError } from "@bigbud/contracts/server/server.remoteFolders";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { startupFailure } from "./sshOwnerDevPicker.errors.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.session.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import { PickerProofStartupRetirementError } from "./sshOwnerPickerProof.startupDiagnostic.ts";
import { REMOTE_TARGET_DISCONNECTED_MESSAGE } from "./sshTargetDisconnects.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const host = "[127.0.0.1]:3030";
const input = { executionTargetId: "ssh://tester@127.0.0.1:3030" };
const other = { executionTargetId: `${input.executionTargetId}?transport=agent` };
const key = { keyType: "ssh-ed25519", fingerprint: "SHA256:fixture" };
const ownerToken = new Uint8Array(32).fill(7);
const folders = {
  path: "/fixtures/project",
  homePath: "/fixtures",
  folders: [{ name: "nested", isGitRepo: true }],
  truncated: true,
};

function fixture() {
  const client = {
    listRemoteFolders: vi.fn<PickerProofOwner["listRemoteFolders"]>().mockResolvedValue(folders),
    listAliases: vi
      .fn<PickerProofOwner["listAliases"]>()
      .mockResolvedValue({ entries: [], truncated: false, maxEntries: 256 }),
    inspectTrust: vi
      .fn<PickerProofOwner["inspectTrust"]>()
      .mockResolvedValue({ state: "approvalRequired", ...key, challenge: ownerToken }),
    approveTrust: vi
      .fn<PickerProofOwner["approveTrust"]>()
      .mockResolvedValue({ state: "verified", ...key }),
    connect: vi.fn<PickerProofOwner["connect"]>().mockResolvedValue({ state: "connected" }),
    disconnect: vi
      .fn<PickerProofOwner["disconnect"]>()
      .mockResolvedValue({ state: "disconnected" }),
    close: vi.fn<PickerProofOwner["close"]>().mockResolvedValue(undefined),
  };
  const startOwner = vi.fn(async (_profileBinding: Uint8Array) => client);
  return { client, startOwner, picker: makeSshOwnerDevPicker({ ...input, host, startOwner }) };
}

function decodeChallenge(message: string) {
  expect(message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
  return Schema.decodeUnknownSync(SshHostTrustChallenge)(
    JSON.parse(message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
  );
}

async function inspect(picker: ReturnType<typeof makeSshOwnerDevPicker>) {
  const trust = await picker.inspectTrust(input);
  if (trust.state !== "approvalRequired") throw new Error("Expected a host trust challenge");
  return trust.challenge;
}

async function rejection(result: Promise<unknown>): Promise<Error> {
  try {
    await result;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected a rejected operation");
}

const ownerError = (code: PickerProofOwnerError["code"]) => new PickerProofOwnerError(code);

describe("development SSH owner picker", () => {
  it("lets one folder waiter cancel during owner bootstrap without aborting the other", async () => {
    const { client, startOwner, picker } = fixture();
    const entered = Promise.withResolvers<void>();
    const startup = Promise.withResolvers<typeof client>();
    startOwner.mockImplementationOnce(() => {
      entered.resolve();
      return startup.promise;
    });
    const controller = new AbortController();
    const first = rejection(picker.listRemoteFolders(input, controller.signal));
    try {
      await entered.promise;
      const second = picker.listRemoteFolders({ ...input, path: "~/second" });
      controller.abort();
      expect((await first).message).toMatch(/aborted/i);
      expect(client.listRemoteFolders).not.toHaveBeenCalled();
      startup.resolve(client);
      await expect(second).resolves.toEqual(folders);
      expect(startOwner).toHaveBeenCalledOnce();
      expect(client.listRemoteFolders).toHaveBeenCalledExactlyOnceWith({
        ...input,
        path: "~/second",
      });
      expect(client.close).not.toHaveBeenCalled();
    } finally {
      startup.resolve(client);
      await picker.close();
    }
  });
  it("drops a trust prompt when its folder request is cancelled during inspection", async () => {
    const { client, picker } = fixture();
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof client.inspectTrust>>>();
    client.listRemoteFolders.mockRejectedValueOnce(ownerError("trustRequired"));
    client.inspectTrust.mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const controller = new AbortController();
    const cancelled = rejection(picker.listRemoteFolders(input, controller.signal));
    try {
      await entered.promise;
      controller.abort();
      pending.resolve({ state: "approvalRequired", ...key, challenge: ownerToken });
      expect((await cancelled).message).not.toContain(SSH_HOST_TRUST_REQUIRED_PREFIX);
      expect(client.approveTrust).not.toHaveBeenCalled();
      await expect(picker.listRemoteFolders(input)).resolves.toEqual(folders);
    } finally {
      await picker.close();
    }
  });
  it.each([
    ["configUnsupported", "sshConfigUnsupported", "Review the alias configuration"],
    ["hostKeyChanged", "sshHostKeyChanged", "host key changed"],
    ["authRequired", "sshAuthenticationRejected", "Check the login and key"],
    ["transportLost", "sshTransportLost", "host and port are reachable"],
    ["sessionQuota", "sshSessionQuota", "session limit"],
    ["windowsPasswordUnsupported", "sshWindowsPasswordUnsupported", "Use an SSH key"],
    ["keyboardInteractiveUnsupported", "sshKeyboardInteractiveUnsupported", "keyboard-interactive"],
    ["ownerRetirementUnverified", "sshOwnerRetirementUnverified", "retirement"],
  ] as const)("reports %s with its own RPC category", async (nativeCode, code, hint) => {
    const { client, picker } = fixture();
    client.listRemoteFolders.mockRejectedValueOnce(ownerError(nativeCode));
    try {
      const error = await rejection(picker.listRemoteFolders(input));
      const decoded = Schema.decodeUnknownSync(ServerListRemoteFoldersError)({
        _tag: "ServerListRemoteFoldersError",
        message: error.message,
        code: "code" in error ? error.code : undefined,
      });
      expect(decoded).toMatchObject({ code, message: expect.stringContaining(hint) });
      expect(client.inspectTrust).not.toHaveBeenCalled();
    } finally {
      await picker.close();
    }
  });
  it.each([
    ["hostKeyChanged", "handshake", "SSH route hop 2 failed while connecting"],
    ["trustRequired", "admission", "requires an approved host key for each hop"],
  ] as const)(
    "preserves the routed %s error without direct trust inspection",
    async (code, stage, message) => {
      const { client, picker } = fixture();
      client.listRemoteFolders.mockRejectedValueOnce(
        new PickerProofOwnerError(code, { leg: 2, stage }),
      );
      try {
        await expect(picker.listRemoteFolders(input)).rejects.toMatchObject({
          message: expect.stringContaining(message),
        });
        expect(client.inspectTrust).not.toHaveBeenCalled();
      } finally {
        await picker.close();
      }
    },
  );

  it("returns the legacy folder, path verification, and connection results without legacy SSH", async () => {
    const { client, startOwner, picker } = fixture();
    await expect(picker.listRemoteFolders(input)).resolves.toEqual(folders);
    await expect(picker.verifyExecutionTarget({ ...input, cwd: "~/project" })).resolves.toEqual({
      ...input,
      cwd: folders.path,
      message: `Connected to ${host}. Remote path resolved to ${folders.path}.`,
      remoteAgent: { status: "disabled" },
    });
    expect(client.listRemoteFolders.mock.calls).toEqual([
      [input],
      [{ ...input, path: "~/project" }],
    ]);
    await expect(picker.disconnectExecutionTarget(input)).resolves.toEqual({
      ...input,
      disconnected: true,
    });
    await expect(picker.connectExecutionTarget(input)).resolves.toEqual({
      ...input,
      disconnected: false,
    });
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.inspectTrust).not.toHaveBeenCalled();
    expect(startOwner).toHaveBeenCalledOnce();
    await Promise.all([picker.close(), picker.close()]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does not present or approve an unexpected fixture fingerprint", async () => {
    const { client, startOwner } = fixture();
    client.listRemoteFolders.mockRejectedValueOnce(ownerError("trustRequired"));
    const picker = makeSshOwnerDevPicker({
      ...input,
      host,
      startOwner,
      expectedFingerprint: "SHA256:expected",
    });
    await expect(picker.listRemoteFolders(input)).rejects.toThrow("host key changed");
    await expect(picker.trustSshHost({ ...input, challengeId: "guessed" })).rejects.toThrow();
    expect(client.approveTrust).not.toHaveBeenCalled();
  });

  it("rejects every unbound target before starting the owner", async () => {
    const { startOwner, picker } = fixture();
    await Promise.all(
      [
        picker.inspectTrust(other),
        picker.listRemoteFolders(other),
        picker.trustSshHost({ ...other, challengeId: "guess" }),
        picker.verifyExecutionTarget(other),
        picker.connectExecutionTarget(other),
        picker.disconnectExecutionTarget(other),
      ].map((request) =>
        expect(request).rejects.toMatchObject({
          message: expect.stringContaining("configured fixture target"),
        }),
      ),
    );
    expect(startOwner).not.toHaveBeenCalled();
  });

  it("maps trust-required listing and verify failures to the legacy approval prompt", async () => {
    const { client, picker } = fixture();
    client.listRemoteFolders
      .mockRejectedValueOnce(ownerError("trustRequired"))
      .mockRejectedValueOnce(ownerError("trustRequired"));
    const listFailure = await rejection(picker.listRemoteFolders(input));
    expect(listFailure).toHaveProperty("_tag", "ServerListRemoteFoldersError");
    const wireFailure = Schema.encodeUnknownSync(ServerListRemoteFoldersError)(listFailure);
    const first = decodeChallenge(wireFailure.message);
    const verifyFailure = await rejection(picker.verifyExecutionTarget(input));
    expect(verifyFailure).toHaveProperty("_tag", "ServerVerifyExecutionTargetError");
    const current = decodeChallenge(verifyFailure.message);
    expect(current).toEqual({
      ...key,
      host,
      challengeId: expect.stringMatching(/^rust-dev:[\w-]{43}$/),
    });
    expect(current.challengeId).not.toBe(first.challengeId);
    expect(current.challengeId).not.toBe(Buffer.from(ownerToken).toString("base64url"));
    expect(client.approveTrust).not.toHaveBeenCalled();
    await expect(
      picker.trustSshHost({ ...input, challengeId: first.challengeId }),
    ).rejects.toMatchObject({
      _tag: "ServerTrustSshHostError",
      cause: { code: "invalidChallenge" },
    });
    await expect(
      picker.trustSshHost({ ...input, challengeId: current.challengeId }),
    ).resolves.toEqual({ message: "SSH host trusted." });
    expect(client.approveTrust).toHaveBeenCalledExactlyOnceWith(ownerToken);
    await expect(
      picker.trustSshHost({ ...input, challengeId: current.challengeId }),
    ).rejects.toMatchObject({ cause: { code: "invalidChallenge" } });
    expect(client.approveTrust).toHaveBeenCalledOnce();
    await expect(picker.verifyExecutionTarget(input)).resolves.toMatchObject({ cwd: folders.path });
  });

  it("binds an approval to the exact target and fresh dev profile, and revokes it on disconnect", async () => {
    const first = fixture();
    const second = fixture();
    const { challengeId } = await inspect(first.picker);
    const secondChallenge = await inspect(second.picker);
    const firstBinding = first.startOwner.mock.calls[0]?.[0];
    expect(firstBinding).toHaveLength(32);
    expect(firstBinding).not.toEqual(second.startOwner.mock.calls[0]?.[0]);
    expect(challengeId).not.toBe(secondChallenge.challengeId);
    await expect(second.picker.trustSshHost({ ...input, challengeId })).rejects.toMatchObject({
      cause: { code: "invalidChallenge" },
    });
    await expect(first.picker.trustSshHost({ ...other, challengeId })).rejects.toMatchObject({
      cause: { code: "unsupportedTarget" },
    });
    await first.picker.disconnectExecutionTarget(input);
    await first.picker.connectExecutionTarget(input);
    await expect(first.picker.trustSshHost({ ...input, challengeId })).rejects.toMatchObject({
      cause: { code: "invalidChallenge" },
    });
    expect(first.client.approveTrust).not.toHaveBeenCalled();
    expect(second.client.approveTrust).not.toHaveBeenCalled();
  });

  it("consumes the local challenge when the owner rejects it as expired", async () => {
    const { client, picker } = fixture();
    const { challengeId } = await inspect(picker);
    client.approveTrust.mockRejectedValueOnce(ownerError("operationDenied"));
    const approval = { ...input, challengeId };
    await expect(picker.trustSshHost(approval)).rejects.toMatchObject({
      cause: { code: "invalidChallenge" },
    });
    await expect(picker.trustSshHost(approval)).rejects.toMatchObject({
      cause: { code: "invalidChallenge" },
    });
    expect(client.approveTrust).toHaveBeenCalledOnce();
  });

  it("preserves changed-host failures without prompting for approval or retrying", async () => {
    const { client, picker } = fixture();
    client.listRemoteFolders.mockRejectedValue(ownerError("hostKeyChanged"));
    await expect(picker.listRemoteFolders(input)).rejects.toMatchObject({
      _tag: "ServerListRemoteFoldersError",
      message: expect.stringContaining("SSH host key changed"),
      cause: { code: "hostKeyChanged" },
    });
    expect(client.listRemoteFolders).toHaveBeenCalledOnce();
    expect(client.inspectTrust).not.toHaveBeenCalled();
    expect(client.approveTrust).not.toHaveBeenCalled();
  });

  it("distinguishes startup failure, lost owner, and deliberate disconnect", async () => {
    const startup = fixture();
    startup.startOwner.mockRejectedValue(ownerError("ownerUnavailable"));
    await expect(startup.picker.listRemoteFolders(input)).rejects.toMatchObject({
      _tag: "ServerListRemoteFoldersError",
      message: expect.stringContaining("failed to start"),
      cause: { code: "startupFailed" },
    });
    await expect(startup.picker.disconnectExecutionTarget(input)).rejects.toMatchObject({
      _tag: "ServerRemoteConnectionError",
      cause: { code: "startupFailed" },
    });
    expect(startup.startOwner).toHaveBeenCalledOnce();
    expect(startup.client.listRemoteFolders).not.toHaveBeenCalled();
    const running = fixture();
    running.client.listRemoteFolders
      .mockRejectedValueOnce(ownerError("targetDisconnected"))
      .mockRejectedValueOnce(ownerError("ownerUnavailable"));
    await expect(running.picker.verifyExecutionTarget(input)).rejects.toMatchObject({
      _tag: "ServerVerifyExecutionTargetError",
      message: REMOTE_TARGET_DISCONNECTED_MESSAGE,
      cause: { code: "REMOTE_TARGET_DISCONNECTED" },
    });
    await expect(running.picker.listRemoteFolders(input)).rejects.toMatchObject({
      _tag: "ServerListRemoteFoldersError",
      message: expect.stringContaining("no longer available"),
      cause: { code: "ownerUnavailable" },
    });
    expect(running.client.inspectTrust).not.toHaveBeenCalled();
    expect(running.startOwner).toHaveBeenCalledOnce();
  });

  it("never retries an ambiguous mutation", async () => {
    const { client, picker } = fixture();
    client.disconnect.mockRejectedValueOnce(ownerError("outcomeUnknown"));
    await expect(picker.disconnectExecutionTarget(input)).rejects.toMatchObject({
      _tag: "ServerRemoteConnectionError",
      message: expect.stringContaining("not retried"),
      cause: { code: "outcomeUnknown" },
    });
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("serializes picker operations and rejects queued work on close", async () => {
    const { client, picker } = fixture();
    const listing = Promise.withResolvers<typeof folders>();
    client.listRemoteFolders.mockReturnValueOnce(listing.promise);
    const first = picker.listRemoteFolders(input);
    await vi.waitFor(() => expect(client.listRemoteFolders).toHaveBeenCalledOnce());
    const queued = rejection(picker.disconnectExecutionTarget(input));
    const closed = picker.close();
    listing.resolve(folders);
    // A Disconnect request fences the in-flight read even though close later drops the request.
    await expect(first).rejects.toThrow(REMOTE_TARGET_DISCONNECTED_MESSAGE);
    await expect(queued).resolves.toHaveProperty("cause.code", "closed");
    await closed;
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("maps a retirement startup diagnostic to its typed refusal", () => {
    const error = startupFailure(
      new PickerProofStartupRetirementError(
        "The previous SSH owner could not be verified; use --retirement-recover.",
      ),
    );
    expect(error.code).toBe("ownerRetirementUnverified");
    expect(error.message).toContain("--retirement-recover");
  });
});

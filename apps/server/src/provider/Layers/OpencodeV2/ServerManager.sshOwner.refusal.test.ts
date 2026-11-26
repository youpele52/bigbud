import { expect, it, vi } from "vitest";

import { PickerProofOwnerError } from "../../../ssh/sshOwnerPickerProof.codec.wire.ts";
import { startOwnedV2Process } from "./ServerManager.child.ts";
import { makeV2SshOwner, type V2SshOwnerClient } from "./ServerManager.sshOwner.ts";

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnSpy,
}));

it("surfaces a missing remote executable as its typed reason, not a cleanup failure", async () => {
  let opened: Uint8Array | undefined;
  const client: V2SshOwnerClient = {
    async openOpencodeV2(lease) {
      opened = Uint8Array.from(lease);
      return { lease: opened, phase: "starting" };
    },
    async opencodeV2Status() {
      // The owner settled the lease: no executable passed its guard.
      throw new PickerProofOwnerError("providerExecutableUnavailable");
    },
    async closeOpencodeV2(lease) {
      return { lease, phase: "closed" };
    },
  };
  const owner = makeV2SshOwner(
    client,
    "ssh:fixture",
    () => ({ ownerEpoch: new Uint8Array(32).fill(1), targetGeneration: new Uint8Array(32) }),
    "/.bigbud-owner-discovery/opencode",
  );
  const failure = await startOwnedV2Process(
    {
      runtimeTargetId: "ssh:fixture",
      binaryPath: "/.bigbud-owner-discovery/opencode",
      profileRoot: "/nonexistent/profile",
      workspaceRoot: "/srv/work",
    },
    undefined,
    owner,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(opened).toBeDefined();
  expect(failure).toBeInstanceOf(PickerProofOwnerError);
  expect(failure).toMatchObject({ code: "providerExecutableUnavailable" });
  expect(spawnSpy).not.toHaveBeenCalled();
});

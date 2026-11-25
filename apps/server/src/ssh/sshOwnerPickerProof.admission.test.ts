import { randomBytes } from "node:crypto";
import path from "node:path";

import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  encodeHello,
  encodeRequest,
  encodeStorageSnapshot,
  OWNER_MAJOR,
} from "./sshOwnerPickerProof.codec.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { spawnPickerProofPipe } from "./sshOwnerPickerProof.pipe.ts";
import { hydratePickerProofTarget } from "./sshOwnerPickerProof.storage.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const UNKNOWN_OPERATION_TAG = 127;
const OPERATION_DENIED = 2;

function unknownOperation(request: {
  requestId: Uint8Array;
  ownerEpoch: Uint8Array;
  generation: Uint8Array;
  targetId: string;
}) {
  const body = new WireWriter();
  body.fieldBytes(1, request.requestId);
  body.fieldBytes(2, request.ownerEpoch);
  body.fieldBytes(3, request.generation);
  body.fieldString(4, request.targetId);
  body.fieldRepeatedMessage(UNKNOWN_OPERATION_TAG, new Uint8Array());
  const frame = new WireWriter();
  frame.fieldRepeatedMessage(5, body.finish());
  return frame.finish();
}

it.skipIf(!pickerProofOptedIn)(
  "the live owner refuses unknown and altered grants before any endpoint attempt",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      await fixture.start();
      await storageScope(path.join(fixture.root, "wire-admission.sqlite"), (sql) =>
        Effect.promise(async () => {
          const {
            binary,
            profileBinding,
            targetId,
            lockFile,
            sshBinary,
            keyscanBinary,
            host,
            port,
            user,
            identityFile,
            knownHostsFile,
          } = options;
          const pipe = spawnPickerProofPipe(
            binary,
            [
              profileBinding.toString("hex"),
              targetId,
              lockFile,
              sshBinary,
              keyscanBinary,
              host,
              String(port),
              user,
              identityFile,
              knownHostsFile,
            ],
            fixture.root,
            false,
          );
          try {
            await expect(
              pipe.exchange(encodeHello(profileBinding, OWNER_MAJOR)),
            ).resolves.toMatchObject({ kind: "storageHydrate", targetId });
            const snapshot = await hydratePickerProofTarget(sql, targetId);
            const accepted = await pipe.exchange(encodeStorageSnapshot(targetId, snapshot));
            if (accepted.kind !== "helloAccepted") throw new Error("Expected proof session");
            const base = {
              requestId: randomBytes(16),
              ownerEpoch: accepted.ownerEpoch,
              generation: accepted.generation,
              targetId,
            };
            const before = fixture.connectionStarts();
            await expect(pipe.exchange(unknownOperation(base))).resolves.toMatchObject({
              kind: "grantReply",
              error: OPERATION_DENIED,
              grant: new Uint8Array(),
            });

            const intent = {
              ...base,
              requestId: randomBytes(16),
              operation: { kind: "inspectTrust" } as const,
            };
            const grant = await pipe.exchange(encodeRequest(intent));
            if (grant.kind !== "grantReply" || grant.error !== 0)
              throw new Error("Expected inspect grant");
            await expect(
              pipe.exchange(
                encodeRequest(
                  { ...intent, operation: { kind: "listFolders", path: "/" } },
                  grant.grant,
                ),
              ),
            ).resolves.toMatchObject({
              kind: "reply",
              outcome: { kind: "error", code: "operationDenied" },
            });
            expect(fixture.connectionStarts()).toBe(before);
            expect(fixture.acceptedPublicKeys()).toBe(0);

            // Prove the same endpoint and observer can see an admitted credential-free probe.
            const valid = { ...intent, requestId: randomBytes(16) };
            const admitted = await pipe.exchange(encodeRequest(valid));
            if (admitted.kind !== "grantReply" || admitted.error !== 0)
              throw new Error("Expected fresh inspect grant");
            await expect(
              pipe.exchange(encodeRequest(valid, admitted.grant)),
            ).resolves.toMatchObject({
              kind: "reply",
              outcome: { kind: "trust", value: { state: "approvalRequired" } },
            });
            await vi.waitFor(() => expect(fixture.connectionStarts()).toBeGreaterThan(before));
            expect(fixture.acceptedPublicKeys()).toBe(0);
          } finally {
            await pipe.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);

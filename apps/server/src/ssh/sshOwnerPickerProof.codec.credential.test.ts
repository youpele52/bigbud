import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  isCredentialOperation,
  readCredentialOutcome,
  writeCredential,
  type CredentialOperation,
} from "./sshOwnerPickerProof.codec.credential.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const lease = new Uint8Array(32).fill(0xc1);
const encode = (operation: CredentialOperation) => {
  const writer = new WireWriter();
  writeCredential(writer, operation);
  return Buffer.from(writer.finish()).toString("hex");
};
/** The outcome body after its field key and length, from a golden reply frame. */
const body = (name: string, key: string) => {
  const hex = frames.get(name)!;
  const at = hex.lastIndexOf(key) + key.length;
  return Buffer.from(hex.slice(at + 2), "hex");
};

describe("in-app credential codec (v1.credential.proto)", () => {
  it("encodes exactly the golden request operands, with no secret field", () => {
    const cases: ReadonlyArray<readonly [string, CredentialOperation]> = [
      ["inspect_credential", { kind: "inspectCredential" }],
      [
        "credential_unlock_open_password",
        { kind: "credentialUnlockOpen", lease, credential: "password" },
      ],
      [
        "credential_unlock_open_passphrase",
        { kind: "credentialUnlockOpen", lease, credential: "keyPassphrase" },
      ],
      ["credential_unlock_commit", { kind: "credentialUnlockCommit", lease }],
      ["credential_lock", { kind: "credentialLock" }],
    ];
    for (const [name, operation] of cases) {
      expect(isCredentialOperation(operation)).toBe(true);
      expect(frames.get(name)?.endsWith(encode(operation))).toBe(true);
    }
    expect(() => encode({ kind: "credentialUnlockCommit", lease: new Uint8Array(3) })).toThrow(
      PickerProofOwnerError,
    );
    expect(isCredentialOperation({ kind: "providerLeaseOpen" })).toBe(false);
  });

  it("decodes the golden state and entry-socket replies", () => {
    expect(readCredentialOutcome(106, body("credential_state_password_locked", "d206"))).toEqual({
      kind: "credentialState",
      value: { credential: "password", unlocked: false, attemptsRemaining: 3 },
    });
    expect(
      readCredentialOutcome(106, body("credential_state_passphrase_unlocked", "d206")),
    ).toEqual({
      kind: "credentialState",
      value: {
        credential: "keyPassphrase",
        unlocked: true,
        attemptsRemaining: 3,
        identity: "/home/u/.ssh/id_ed25519",
      },
    });
    const unlock = readCredentialOutcome(107, body("credential_unlock_lease", "da06"));
    expect(unlock.kind).toBe("credentialUnlockLease");
  });

  it("refuses an identity on a password state and out-of-range attempts", () => {
    const state = (fields: (writer: WireWriter) => void) => {
      const writer = new WireWriter();
      fields(writer);
      return writer.finish();
    };
    expect(() =>
      readCredentialOutcome(
        106,
        state((w) => {
          w.fieldUint(1, 2);
          w.fieldString(4, "/home/u/.ssh/id");
        }),
      ),
    ).toThrow(PickerProofOwnerError);
    expect(() =>
      readCredentialOutcome(
        106,
        state((w) => {
          w.fieldUint(1, 2);
          w.fieldUint(3, 9);
        }),
      ),
    ).toThrow(PickerProofOwnerError);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  readPeerProductionOutcome,
  writePeerProduction,
  type PeerProductionOperation,
} from "./sshOwnerPickerProof.codec.peerProduction.ts";
import { bytesValue, decodeOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const PAIRING = "5eb1c0de-1111-4222-8333-444455556666";
const challenge = new Uint8Array(32).fill(0x24);
const lease = new Uint8Array(32).fill(0x79);

function encode(operation: PeerProductionOperation): string {
  const writer = new WireWriter();
  writePeerProduction(writer, operation);
  return Buffer.from(writer.finish()).toString("hex");
}

/** The selected reply outcome of a golden frame: its field number and bytes. */
function outcome(name: string): [number, Uint8Array] {
  const payload = Buffer.from(frames.get(name)!, "hex").subarray(4);
  let selected: [number, Uint8Array] | undefined;
  decodeMessage(payload, (field, wire, reader) => {
    if (field !== 4) return reader.skip(wire);
    decodeMessage(bytesValue(wire, reader), (inner, innerWire, innerReader) => {
      if (inner >= 10) selected = [inner, bytesValue(innerWire, innerReader)];
      else innerReader.skip(innerWire);
    });
  });
  return selected!;
}

describe("U24 production peer codec", () => {
  it("encodes exactly the golden request operations", () => {
    for (const [name, operation] of [
      ["ensure_peer_coordinator_key", { kind: "ensurePeerCoordinatorKey" }],
      ["inspect_peer_host_key", { kind: "inspectPeerHostKey", host: "w1.example.test", port: 22 }],
      [
        "approve_peer_pin",
        { kind: "approvePeerPin", challenge, pairingId: PAIRING, user: "bbpeer" },
      ],
      ["revoke_peer_pin", { kind: "revokePeerPin", pairingId: PAIRING }],
      ["peer_relay_open", { kind: "peerRelayOpen", lease, pairingId: PAIRING }],
      ["peer_relay_status", { kind: "peerRelayStatus", lease }],
      ["peer_relay_close", { kind: "peerRelayClose", lease }],
    ] as const) {
      expect(frames.get(name)?.endsWith(encode(operation)), name).toBe(true);
    }
  });

  it("refuses operands that would name a host, key or user in a relay", () => {
    for (const operation of [
      { kind: "inspectPeerHostKey", host: "-oProxyCommand=x", port: 22 },
      { kind: "inspectPeerHostKey", host: "user@w1", port: 22 },
      { kind: "approvePeerPin", challenge: new Uint8Array(3), pairingId: PAIRING, user: "bbpeer" },
      { kind: "approvePeerPin", challenge, pairingId: "w1.example.test", user: "bbpeer" },
      { kind: "approvePeerPin", challenge, pairingId: PAIRING, user: "-l root" },
      { kind: "peerRelayOpen", lease, pairingId: "../pairing" },
    ] as const) {
      expect(() => encode(operation as PeerProductionOperation)).toThrow(/invalidOperands/);
    }
  });

  it("decodes the golden replies and typed peer errors", () => {
    const [keyField, key] = outcome("peer_coordinator_key");
    expect(readPeerProductionOutcome(keyField as 76, key)).toMatchObject({
      kind: "peerCoordinatorKey",
      value: { algorithm: "ssh-ed25519", fingerprint: `sha256:${"1".repeat(64)}` },
    });
    const [hostField, host] = outcome("peer_host_key");
    const presented = readPeerProductionOutcome(hostField as 77, host);
    expect(presented).toMatchObject({ kind: "peerHostKey", value: { keyType: "ssh-ed25519" } });
    expect(presented.kind === "peerHostKey" && [...presented.value.challenge]).toEqual([
      ...challenge,
    ]);
    const [pinField, pin] = outcome("peer_pin");
    expect(readPeerProductionOutcome(pinField as 78, pin)).toMatchObject({
      kind: "peerPin",
      value: { pairingId: PAIRING, host: "w1.example.test", port: 22, user: "bbpeer" },
    });
    const [listenField, listening] = outcome("peer_relay_listening");
    expect(readPeerProductionOutcome(listenField as 79, listening)).toMatchObject({
      kind: "peerRelay",
      value: { phase: "listening", pairingId: PAIRING, socketPath: "/tmp/bigbud-peer-relay/s" },
    });
    const [exitField, exited] = outcome("peer_relay_exited");
    expect(readPeerProductionOutcome(exitField as 79, exited)).toMatchObject({
      kind: "peerRelay",
      value: { phase: "exited", exitCode: 0 },
    });
    expect([59, 60, 61, 62].map(decodeOwnerError)).toEqual([
      "peerKeyCorrupt",
      "peerPinUnknown",
      "peerPinMismatch",
      "peerAuthRefused",
    ]);
  });

  it("rejects a host-key reply without a full challenge", () => {
    const writer = new WireWriter();
    writer.fieldString(1, "ssh-ed25519");
    writer.fieldString(2, "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk");
    writer.fieldString(3, `ssh-ed25519 ${"A".repeat(68)}`);
    writer.fieldBytes(4, new Uint8Array(3));
    expect(() => readPeerProductionOutcome(77, writer.finish())).toThrow();
  });
});

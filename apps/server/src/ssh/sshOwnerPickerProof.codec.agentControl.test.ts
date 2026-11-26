import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  readAgentControlState,
  writeAgentControl,
  type AgentControlOperation,
} from "./sshOwnerPickerProof.codec.agentControl.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const lease = new Uint8Array(32).fill(0x25);
const SHA = "5e17".repeat(16);
const ROOT = "/home/bbdev/.bigbud/agent";
const STATE = `${ROOT}/runtimes/g-5e17`;

function encode(operation: AgentControlOperation): string {
  const writer = new WireWriter();
  writeAgentControl(writer, operation);
  return Buffer.from(writer.finish()).toString("hex");
}

/** Reply body after the outcome tag 81 (8a05) and a one-byte length. */
function state(name: string) {
  const hex = frames.get(name)!;
  return Buffer.from(hex.slice(hex.indexOf("8a05") + 6), "hex");
}

function decoded(name: string) {
  const value = readAgentControlState(state(name));
  return { ...value, lease: Uint8Array.from(value.lease) };
}

describe("U25 agent control codec", () => {
  it("encodes exactly the golden open, status and cancel requests", () => {
    const observe = encode({
      kind: "agentControlOpen",
      lease,
      control: {
        kind: "supervisorObserve",
        observeMode: "candidateStartup",
        attemptId: "launch-g-5e17",
        runtime: {
          generation: "g-5e17",
          version: "0.9.0",
          sha256: SHA,
          buildDigest: "build:5e17",
          targetTriple: "aarch64-unknown-linux-gnu",
          binaryPath: `${ROOT}/bin/0.9.0/${SHA}/bigbud-remote-agent`,
          statePath: STATE,
          socketPath: `${STATE}/supervisor.sock`,
          logPath: `${STATE}/supervisor.log`,
          origin: "managed",
        },
      },
    });
    expect(frames.get("agent_control_open")?.endsWith(observe)).toBe(true);
    const cas = encode({
      kind: "agentControlOpen",
      lease,
      control: {
        kind: "registryCas",
        expected: { size: 512, sha256: SHA },
        next: { size: 640, sha256: SHA },
      },
    });
    expect(frames.get("agent_control_open_registry_cas")?.endsWith(cas)).toBe(true);
    const upload = encode({
      kind: "agentControlOpen",
      lease,
      control: {
        kind: "installUpload",
        reservationId: "stage-5e17",
        version: "0.9.0",
        sha256: SHA,
        size: 4_194_304,
      },
    });
    expect(frames.get("agent_control_open_install_upload")?.endsWith(upload)).toBe(true);
    expect(
      frames.get("agent_control_status")?.endsWith(encode({ kind: "agentControlStatus", lease })),
    ).toBe(true);
    expect(
      frames.get("agent_control_cancel")?.endsWith(encode({ kind: "agentControlCancel", lease })),
    ).toBe(true);
  });

  it("refuses a malformed lease token before the wire", () => {
    expect(() => encode({ kind: "agentControlStatus", lease: new Uint8Array(4) })).toThrow(
      PickerProofOwnerError,
    );
  });

  it("decodes the golden states and refuses inconsistent ones", () => {
    expect(decoded("agent_control_listening")).toEqual({
      lease,
      kind: "installUpload",
      phase: "listening",
      socketPath: "/tmp/bigbud-agent-control/s",
    });
    expect(decoded("agent_control_exited")).toEqual({
      lease,
      kind: "supervisorObserve",
      phase: "exited",
      exitCode: 0,
      stdout: "ready",
      stderr: "",
    });
    expect(decoded("agent_control_outcome_unknown")).toEqual({
      lease,
      kind: "registryCas",
      phase: "outcomeUnknown",
    });
    const writer = new WireWriter();
    writer.fieldBytes(1, lease);
    writer.fieldUint(2, 5);
    writer.fieldUint(3, 3);
    writer.fieldString(6, "late output");
    expect(() => readAgentControlState(writer.finish())).toThrow(PickerProofOwnerError);
  });
});

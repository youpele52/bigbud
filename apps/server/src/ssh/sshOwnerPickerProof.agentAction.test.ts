import { expect, it } from "vitest";
import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { readReply } from "./sshOwnerPickerProof.codec.outcome.ts";
import { encodeRequest } from "./sshOwnerPickerProof.codec.ts";
import {
  AGENT_ACTION_KINDS,
  MAX_AGENT_ACTION_ARTIFACT_BYTES,
  readProofAgentActionResult,
  writeProofAgentAction,
  type AgentActionName,
  type ProofAgentActionOperation,
} from "./sshOwnerPickerProof.codec.agentAction.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import { bytesValue } from "./sshOwnerPickerProof.codec.wire.ts";

const id = new Uint8Array(32).map((_, index) => index);
const request = (operation: PickerProofOperation) => ({
  requestId: id,
  ownerEpoch: id,
  generation: id,
  targetId: "fixture",
  operation,
});

/** Operation body of field 70 from a fully encoded request. */
function operationBody(operation: PickerProofOperation): Uint8Array {
  let found: Uint8Array | undefined;
  decodeMessage(encodeRequest(request(operation)), (_field, wire, frame) => {
    decodeMessage(bytesValue(wire, frame), (field, inner, reader) => {
      if (field === 70) found = bytesValue(inner, reader);
      else reader.skip(inner);
    });
  });
  if (!found) throw new Error("missing agent action operation");
  return found;
}

function fieldMap(body: Uint8Array): Map<number, Uint8Array | number> {
  const fields = new Map<number, Uint8Array | number>();
  let offset = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = body[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (offset < body.length) {
    const tag = varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) fields.set(field, varint());
    else if (wire === 2) {
      const length = varint();
      fields.set(field, body.subarray(offset, offset + length));
      offset += length;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

const boundedArtifact = (size: number) => {
  const bytes = new Uint8Array(size).map((_, index) => index % 251);
  return {
    version: "0.3.3",
    sha256: "b".repeat(64),
    size,
    targetTriple: "aarch64-unknown-linux-gnu",
    bytes,
  };
};

it("encodes enum-only verbs for platform, status and control", () => {
  for (const [name, number] of Object.entries(AGENT_ACTION_KINDS)) {
    if (name === "install" || name === "update") continue;
    const fields = fieldMap(
      operationBody({
        kind: "proofAgentAction",
        action: name as AgentActionName,
        operationId: id,
      }),
    );
    expect([...fields.keys()].toSorted()).toEqual([1, 2]);
    expect(fields.get(1)).toBe(number);
    expect(fields.get(2)).toEqual(id);
  }
});

it("sends install artifact bytes only through the bounded artifact field", () => {
  const artifact = boundedArtifact(MAX_AGENT_ACTION_ARTIFACT_BYTES);
  const fields = fieldMap(
    operationBody({ kind: "proofAgentAction", action: "install", operationId: id, artifact }),
  );
  expect([...fields.keys()].toSorted()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(fields.get(7)).toEqual(artifact.bytes);
  // No command, argument, cwd or environment field exists on this verb.
  expect([...fields.keys()].every((field) => field <= 7)).toBe(true);
});

it("refuses oversize artifacts and artifact bytes on other verbs", () => {
  const oversize = boundedArtifact(MAX_AGENT_ACTION_ARTIFACT_BYTES + 1);
  expect(() =>
    operationBody({
      kind: "proofAgentAction",
      action: "update",
      operationId: id,
      artifact: oversize,
    }),
  ).toThrow();
  for (const action of ["platformProbe", "remove", "status", "start", "stop", "wake"] as const) {
    expect(() =>
      operationBody({
        kind: "proofAgentAction",
        action,
        operationId: id,
        artifact: boundedArtifact(8),
      }),
    ).toThrow();
    expect(() =>
      operationBody({ kind: "proofAgentAction", action, operationId: id }),
    ).not.toThrow();
  }
});

it("refuses unknown enum values and unbounded operation ids", () => {
  const writer = new WireWriter();
  expect(() =>
    writeProofAgentAction(writer, new WireWriter(), {
      kind: "proofAgentAction",
      action: "deploy" as AgentActionName,
      operationId: id,
    }),
  ).toThrow();
  for (const operationId of [new Uint8Array(15), new Uint8Array(65)]) {
    expect(() =>
      writeProofAgentAction(writer, new WireWriter(), {
        kind: "proofAgentAction",
        action: "status",
        operationId,
      }),
    ).toThrow();
  }
  expect(() => readProofAgentActionResult(Uint8Array.of(0x08, 99, 0x12, 32, ...id))).toThrow();
});

it("never reads a caller-supplied command, argument, cwd or environment", () => {
  const canonical = operationBody({
    kind: "proofAgentAction",
    action: "status",
    operationId: id,
  });
  const smuggled = operationBody({
    kind: "proofAgentAction",
    action: "status",
    operationId: id,
    command: "sh",
    args: ["-lc", "curl evil"],
    cwd: "/",
    env: { PATH: "/tmp" },
  } as ProofAgentActionOperation);
  expect(smuggled).toEqual(canonical);
});

it("decodes exit status, separate streams and ambiguous outcomes", () => {
  const reply = (outcome: Uint8Array) => {
    const writer = new WireWriter();
    writer.fieldRepeatedMessage(44, outcome);
    return readReply(writer.finish()).outcome;
  };
  const body = (fields: Array<[number, number | Uint8Array]>) => {
    const writer = new WireWriter();
    for (const [field, value] of fields) {
      if (typeof value === "number") {
        writer.bytes.push(field * 8, value);
      } else writer.fieldBytes(field, value);
    }
    return writer.finish();
  };
  expect(
    reply(
      body([
        [1, 5],
        [2, id],
        [3, 0],
        [4, new TextEncoder().encode("registry")],
        [5, new TextEncoder().encode("warn")],
      ]),
    ),
  ).toMatchObject({
    kind: "proofAgentAction",
    value: {
      action: "status",
      exitCode: 0,
      stdout: "registry",
      stderr: "warn",
      outcomeUnknown: false,
      reattached: false,
    },
  });
  expect(
    reply(
      body([
        [1, 2],
        [2, id],
        [6, 1],
        [7, 1],
        [8, 1],
      ]),
    ),
  ).toMatchObject({
    kind: "proofAgentAction",
    value: { action: "install", exitCode: undefined, outcomeUnknown: true, reattached: true },
  });
  for (const malformed of [
    body([[2, id]]),
    body([[1, 5]]),
    body([
      [1, 5],
      [2, new Uint8Array(4)],
    ]),
    body([
      [1, 5],
      [2, id],
      [9, 1],
    ]),
  ]) {
    expect(() => reply(malformed)).toThrow();
  }
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeComputerUseFrame, encodeComputerUseFrame } from "./protocol.codec";
import {
  messageFields,
  type ComputerUseFrame,
  type MessageKind,
  type WireRecord,
} from "./protocol.fields";
import { computerUseProtocol } from "./protocol.profile";
import { validateHello } from "./protocol.validation";

const golden = new Map(
  readFileSync(
    new URL("../../../../protocol/computer-use/v1.golden.frames", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => {
      const [name, hex] = line.split("=");
      return [name!, Uint8Array.from(Buffer.from(hex!, "hex"))];
    }),
);
const samples: ComputerUseFrame[] = [
  {
    kind: "hello",
    value: {
      protocol_major: 1,
      protocol_minor: 0,
      tuple_digest: "a".repeat(64),
      role: "server",
      owner_generation: "owner-1",
      worker_generation: "worker-1",
      qualification_profile: computerUseProtocol.profile,
      control_frame_bytes: 65536,
      data_frame_bytes: 25 * 1024 * 1024,
      instance_id: "server-1",
    },
  },
  { kind: "stop", value: { operation_id: "stop-1", desktop_scope: "desktop-1" } },
  {
    kind: "revoked",
    value: {
      operation_id: "stop-1",
      pause_epoch: "18446744073709551615",
      settlement_id: "settlement-1",
    },
  },
  {
    kind: "mediated_call",
    value: { ticket: "ticket-1", primitive_index: 2, mcp_frame: new TextEncoder().encode("{}") },
  },
  {
    kind: "operation_result",
    value: {
      operation_id: "operation-1",
      completion: "unknown",
      code: "retirement_unknown",
      projected_result: new Uint8Array(),
      capture_error: "",
    },
  },
];
const channelFor = (kind: string) =>
  kind === "mediated_call" || kind === "operation_result"
    ? ("data" as const)
    : ("control" as const);

function sample(kind: MessageKind): ComputerUseFrame {
  const value: WireRecord = {};
  for (const [name, [, type]] of Object.entries(messageFields[kind]))
    value[name] =
      type === "s" ? "x" : type === "u64" ? "1" : type === "u32" ? 1 : new Uint8Array(32);
  if (kind === "admit_operation") value.timeout_ms = 10_000;
  if (kind === "operation_result") value.completion = "completed";
  return { kind, value };
}

describe("independent computer-use codec", () => {
  it("rejects shared uint32 overflow vectors rather than truncating versions or helper indices", () => {
    const fixture = readFileSync(
      new URL("../../../../protocol/computer-use/v1.invalid.frames", import.meta.url),
      "utf8",
    );
    for (const line of fixture.trim().split("\n")) {
      const [name, hex] = line.split("=");
      expect(() =>
        decodeComputerUseFrame(
          Uint8Array.from(Buffer.from(hex!, "hex")),
          name!.startsWith("primitive") ? "data" : "control",
        ),
      ).toThrow();
    }
  });
  it.each(samples)("shares the Rust golden $kind", (frame) => {
    const bytes = golden.get(frame.kind)!;
    expect(encodeComputerUseFrame(frame, channelFor(frame.kind))).toEqual(bytes);
    expect(decodeComputerUseFrame(bytes, channelFor(frame.kind))).toEqual(frame);
  });
  it.each(Object.keys(messageFields) as MessageKind[])("round trips every message %s", (kind) => {
    const frame = sample(kind);
    expect(
      decodeComputerUseFrame(encodeComputerUseFrame(frame, channelFor(kind)), channelFor(kind)),
    ).toEqual(frame);
  });
  it("negotiates exact versions, roles, tuple and profile, not claimed process identity", () => {
    const hello = samples[0]!.value;
    expect(() => validateHello(hello, "a".repeat(64))).not.toThrow();
    for (const [key, value] of Object.entries({
      protocol_major: 2,
      protocol_minor: 1,
      role: "provider",
      qualification_profile: "unknown",
      control_frame_bytes: 1,
      data_frame_bytes: 1,
      instance_id: "",
      owner_generation: "",
    }))
      expect(() => validateHello({ ...hello, [key]: value }, "a".repeat(64))).toThrow();
    expect(() => validateHello(hello, "b".repeat(64))).toThrow();
  });
  it("keeps priority control independent of data frames", () => {
    expect(() => encodeComputerUseFrame(samples[3]!, "control")).toThrow();
    expect(() => decodeComputerUseFrame(golden.get("stop")!, "data")).toThrow();
  });
  it("rejects truncation, empty, oversized and multiple payloads", () => {
    for (const bytes of [
      new Uint8Array(),
      Uint8Array.of(0, 0, 0, 0),
      Uint8Array.of(1, 255, 255, 255),
      Uint8Array.of(0, 0, 0, 2, 0x42),
      Uint8Array.of(0, 0, 0, 4, 0x42, 0, 0x42, 0),
    ])
      expect(() => decodeComputerUseFrame(bytes, "control")).toThrow();
  });
  it("rejects duplicate/unknown fields, invalid UTF8 and overflowing integers", () => {
    for (const payload of [
      [0x42, 4, 0x0a, 0, 0x0a, 0],
      [0x42, 2, 0x1a, 0],
      [0x42, 3, 0x0a, 1, 255],
      [0x4a, 11, 0x10, ...Array(9).fill(255), 2],
    ]) {
      const bytes = Uint8Array.of(0, 0, 0, payload.length, ...payload);
      expect(() => decodeComputerUseFrame(bytes, "control")).toThrow();
    }
  });
  it("refuses coercion, unknown fields, malformed Unicode and uint64 overflow", () => {
    for (const value of [
      { ...samples[1]!.value, operation_id: 42 },
      { ...samples[1]!.value, operation_id: "\ud800" },
      { ...samples[1]!.value, operation_id: "a".repeat(129) },
      { ...samples[1]!.value, extra: "no" },
    ])
      expect(() => encodeComputerUseFrame({ kind: "stop", value }, "control")).toThrow();
    for (const pause_epoch of ["18446744073709551616", "01", "-1", 1])
      expect(() =>
        encodeComputerUseFrame(
          { kind: "revoked", value: { ...samples[2]!.value, pause_epoch } },
          "control",
        ),
      ).toThrow();
  });
  it("enforces digest, action timeout and frame-local bounds", () => {
    expect(() =>
      encodeComputerUseFrame(
        {
          kind: "apply_policy",
          value: { ...sample("apply_policy").value, digest: new Uint8Array(31) },
        },
        "control",
      ),
    ).toThrow();
    expect(() =>
      encodeComputerUseFrame(
        {
          kind: "admit_operation",
          value: { ...sample("admit_operation").value, timeout_ms: 9_999 },
        },
        "control",
      ),
    ).toThrow();
    expect(() =>
      encodeComputerUseFrame(
        {
          kind: "mediated_call",
          value: { ...sample("mediated_call").value, mcp_frame: new Uint8Array(25 * 1024 * 1024) },
        },
        "data",
      ),
    ).toThrow();
  });
});

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { spawnPickerProofPipe } from "./sshOwnerPickerProof.pipe.ts";
import {
  PickerProofStartupConfigError,
  PickerProofStartupRetirementError,
  readPickerProofStartupConfigDiagnostic,
} from "./sshOwnerPickerProof.startupDiagnostic.ts";

const rejection = {
  code: "config_unsupported",
  event: "ssh_owner_alias_policy_rejected",
  location: { directive: "ProxyCommand", line: 2, source: "user_include" },
  remedy:
    "Use ProxyCommand nc %h %p (or a qualified absolute nc with exactly %h %p), or a direct route.",
  version: 1,
};
const withoutLocation = {
  ...rejection,
  location: null,
  remedy: "Check the selected owner-private fixture config and its required settings.",
};
const record = JSON.stringify(rejection);

function reader() {
  const stderr = new PassThrough();
  return { stderr, ...readPickerProofStartupConfigDiagnostic(stderr) };
}

describe("picker proof startup config diagnostic", () => {
  it("accepts the first valid record only after its split line terminator", () => {
    const { stderr, startupConfigDiagnostic } = reader();
    stderr.write(`unstructured stderr\n${record.slice(0, 30)}`);
    stderr.write(record.slice(30));
    expect(startupConfigDiagnostic()).toBeUndefined();
    stderr.end(`\n${JSON.stringify(withoutLocation)}\n`);
    expect(startupConfigDiagnostic()).toEqual(rejection);
  });

  it("accepts the canonical record without a source location", () => {
    const { stderr, startupConfigDiagnostic } = reader();
    stderr.end(`${JSON.stringify(withoutLocation)}\n`);
    expect(startupConfigDiagnostic()).toEqual(withoutLocation);
  });

  it("reads the retirement refusal without a config diagnostic", () => {
    const remedy = "The previous SSH owner could not be verified; use --retirement-recover.";
    const { stderr, startupConfigDiagnostic, startupRetirementDiagnostic } = reader();
    stderr.end(
      `${JSON.stringify({
        event: "ssh_owner_retirement_refused",
        version: 1,
        code: "owner_retirement_unverified",
        remedy,
      })}\n`,
    );
    expect(startupConfigDiagnostic()).toBeUndefined();
    expect(startupRetirementDiagnostic()).toBe(remedy);
    const error = new PickerProofStartupRetirementError(remedy);
    expect(error.code).toBe("ownerRetirementUnverified");
    expect(error.message).toBe(remedy);
  });

  it("shows a bounded hop ordinal without forwarding the raw operand", () => {
    const { stderr, startupConfigDiagnostic } = reader();
    stderr.end(
      `${JSON.stringify({
        ...rejection,
        location: { ...rejection.location, directive: "ProxyJump", hop: 2 },
        remedy: "private jump operand",
      })}\n`,
    );
    const diagnostic = startupConfigDiagnostic();
    if (!diagnostic) throw new Error("Missing jump diagnostic");
    const error = new PickerProofStartupConfigError(diagnostic);
    expect(error.message).toContain("ProxyJump hop 2 in user include at line 2");
    expect(error.message).not.toContain("private jump operand");
  });

  it.each([
    ["unknown event", { ...rejection, event: "other" }],
    ["unknown version", { ...rejection, version: 2 }],
    ["unknown code", { ...rejection, code: "owner_unavailable" }],
    ["extra top-level field", { ...rejection, details: "private value" }],
    ["unknown source", { ...rejection, location: { ...rejection.location, source: "/private" } }],
    ["line zero", { ...rejection, location: { ...rejection.location, line: 0 } }],
    ["line too high", { ...rejection, location: { ...rejection.location, line: 262_145 } }],
    ["fractional line", { ...rejection, location: { ...rejection.location, line: 2.5 } }],
    ["hop on another directive", { ...rejection, location: { ...rejection.location, hop: 2 } }],
    [
      "unbounded hop",
      { ...rejection, location: { ...rejection.location, directive: "ProxyJump", hop: 6 } },
    ],
    [
      "inherited directive name",
      { ...rejection, location: { ...rejection.location, directive: "toString" } },
    ],
    [
      "extra location field",
      { ...rejection, location: { ...rejection.location, path: "/private" } },
    ],
  ])("rejects %s", (_label, value) => {
    const { stderr, startupConfigDiagnostic } = reader();
    stderr.end(`${JSON.stringify(value)}\n`);
    expect(startupConfigDiagnostic()).toBeUndefined();
  });

  it.each([rejection, withoutLocation])(
    "reconstructs the remedy without exposing wire text",
    (expected) => {
      const { stderr, startupConfigDiagnostic } = reader();
      const raw = "\u001b[31m/private/owner-fixture\nnever include this raw remedy";
      stderr.end(`${JSON.stringify({ ...expected, remedy: raw })}\n`);
      const diagnostic = startupConfigDiagnostic();
      expect(diagnostic).toEqual(expected);
      if (!diagnostic) throw new Error("No diagnostic retained");
      const error = new PickerProofStartupConfigError(diagnostic);
      for (const output of [error.message, JSON.stringify(error)]) {
        expect(output).not.toContain("/private/owner-fixture");
        expect(output).not.toContain("never include this raw remedy");
      }
    },
  );

  it.each([undefined, { text: "private" }])(
    "rejects non-string or missing wire remedy",
    (remedy) => {
      const { stderr, startupConfigDiagnostic } = reader();
      stderr.end(`${JSON.stringify({ ...rejection, remedy })}\n`);
      expect(startupConfigDiagnostic()).toBeUndefined();
    },
  );

  it("ignores malformed, invalid UTF-8, and unterminated lines", () => {
    const { stderr, startupConfigDiagnostic } = reader();
    stderr.write("{\n");
    stderr.write(Buffer.from([0xc0, 0x8a, 0x0a]));
    stderr.end(record);
    expect(startupConfigDiagnostic()).toBeUndefined();
  });

  it("discards an oversized line across chunks and counts LF in the 512-byte cap", () => {
    const { stderr, startupConfigDiagnostic } = reader();
    stderr.write(record.padEnd(511));
    stderr.write(" \n");
    expect(startupConfigDiagnostic()).toBeUndefined();
    stderr.end(`${record.padEnd(511)}\n`);
    expect(startupConfigDiagnostic()).toEqual(rejection);
  });

  it("discards a partial record on ready and keeps draining stderr", () => {
    const { stderr, startupConfigDiagnostic, sealStartupConfigDiagnostic } = reader();
    stderr.write(record.slice(0, 30));
    sealStartupConfigDiagnostic();
    stderr.write(`${record.slice(30)}\n${record}\n`);
    stderr.write(Buffer.alloc(1024 * 1024));
    expect(stderr.readableLength).toBe(0);
    stderr.end();
    expect(startupConfigDiagnostic()).toBeUndefined();
  });

  it("clears an already buffered record on ready", () => {
    const { stderr, startupConfigDiagnostic, sealStartupConfigDiagnostic } = reader();
    stderr.write(`${record}\n`);
    expect(startupConfigDiagnostic()).toEqual(rejection);
    sealStartupConfigDiagnostic();
    stderr.end(`${record}\n`);
    expect(startupConfigDiagnostic()).toBeUndefined();
  });

  it("drains the spawned owner's FD 2 and leaves agent-proxy FDs at 3–5", async () => {
    const script = `
      const { fstatSync } = require('node:fs');
      for (const fd of [3, 4, 5]) fstatSync(fd);
      process.stderr.write('x'.repeat(1024 * 1024) + '\\n');
      process.stderr.write(${JSON.stringify(`${record}\n`)});
      process.exitCode = 1;
    `;
    const pipe = spawnPickerProofPipe(process.execPath, ["-e", script], process.cwd(), true);
    // The child ignores control input, writes the diagnostic and exits without a hello.
    try {
      expect(pipe.takeAgentProxyPipes().pipes).toHaveProperty("stderr");
      await expect(pipe.exchange(Uint8Array.of(1), 5_000)).rejects.toThrow();
    } finally {
      await pipe.close();
    }
    expect(pipe.startupConfigDiagnostic()).toEqual(rejection);
  });
});

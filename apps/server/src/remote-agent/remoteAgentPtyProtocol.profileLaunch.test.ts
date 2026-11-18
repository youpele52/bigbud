import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import { RemoteAgentProtocolDecodeError, type RemoteAgentFrame } from "./remoteAgentProtocol.ts";

const goldens = Object.fromEntries(
  readFileSync(
    new URL("../../../../protocol/remote-agent/v1.golden.frames", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const [name, hex] = line.split("=", 2);
      return [name, Uint8Array.from(Buffer.from(hex!, "hex"))];
    }),
);

const value = {
  requestId: "create-1",
  ptyId: "pty-1",
  requestDigest: new Uint8Array([1, 2, 3]),
  workspaceHandle: "workspace-1",
  cwd: "",
  shell: "/bin/zsh",
  args: ["-o", "nopromptsp"],
  cols: 80,
  rows: 24,
};

describe("additive exact-profile PTY request marker", () => {
  for (const profileLaunch of [undefined, true] as const) {
    it(`matches the Rust golden with marker ${String(profileLaunch)}`, () => {
      const frame: RemoteAgentFrame = {
        type: "ptyCreateRequest",
        value: { ...value, ...(profileLaunch ? { profileLaunch } : {}) },
      };
      const bytes = goldens[`pty_profile_${profileLaunch ? "true" : "absent"}`]!;
      expect(encodeDelimitedFrame(frame)).toEqual(bytes);
      expect(decodeDelimitedFrame(bytes)).toEqual(frame);
    });
  }

  it("omits explicit false on write and default false on read", () => {
    expect(
      encodeDelimitedFrame({ type: "ptyCreateRequest", value: { ...value, profileLaunch: false } }),
    ).toEqual(goldens.pty_profile_absent);
    expect(decodeDelimitedFrame(goldens.pty_profile_false!).value).not.toHaveProperty(
      "profileLaunch",
    );
  });

  it("preserves protobuf nonzero boolean semantics", () => {
    const bytes = Uint8Array.from(goldens.pty_profile_true!);
    bytes[bytes.length - 1] = 2;
    expect(decodeDelimitedFrame(bytes)).toMatchObject({ value: { profileLaunch: true } });
  });

  for (const name of ["malformed_wire", "malformed_varint"]) {
    it(`rejects ${name} markers`, () => {
      expect(() => decodeDelimitedFrame(goldens[`pty_profile_${name}`]!)).toThrow(
        RemoteAgentProtocolDecodeError,
      );
    });
  }
});

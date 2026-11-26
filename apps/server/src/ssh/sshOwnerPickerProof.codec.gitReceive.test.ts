import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  gitReceiveApprovalAdmits,
  readGitReceive,
  writeGitReceive,
  type GitReceiveOperation,
} from "./sshOwnerPickerProof.codec.gitReceive.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const lease = new Uint8Array(32).fill(94);
const approval = {
  workspaceRoot: "/srv/work",
  repositoryPath: "/srv/work/repo.git",
  destinationRef: "refs/heads/main",
  expectedOldOid: "a".repeat(40),
  sourceOid: "b".repeat(40),
};

function encode(operation: GitReceiveOperation): string {
  const writer = new WireWriter();
  writeGitReceive(writer, operation);
  return Buffer.from(writer.finish()).toString("hex");
}

/** Reply body = tag 66 (0x92 0x04), length, then the state message. */
function state(name: string): Uint8Array {
  const hex = frames.get(name)!;
  const body = hex.slice(hex.indexOf("9204") + 4);
  return Buffer.from(body.slice(2), "hex");
}

describe("U15 Git receive codec", () => {
  it("encodes exactly the golden request operations", () => {
    const open = encode({ kind: "gitReceiveOpen", lease, ...approval });
    expect(frames.get("git_receive_open")?.endsWith(open)).toBe(true);
    expect(
      frames.get("git_receive_status")?.endsWith(encode({ kind: "gitReceiveStatus", lease })),
    ).toBe(true);
    expect(
      frames.get("git_receive_close")?.endsWith(encode({ kind: "gitReceiveClose", lease })),
    ).toBe(true);
  });

  it("decodes the golden listening, accepted and stale replies", () => {
    const listening = readGitReceive(state("git_receive_listening"));
    expect(Array.from(listening.lease)).toEqual(Array.from(lease));
    expect(listening).toMatchObject({
      phase: "listening",
      socketPath: "/tmp/bigbud-oc1-0123456789abcdef/s",
    });
    expect(readGitReceive(state("git_receive_accepted"))).toMatchObject({
      phase: "finished",
      receipt: "accepted",
    });
    expect(readGitReceive(state("git_receive_stale"))).toMatchObject({
      phase: "finished",
      receipt: "stale",
    });
  });

  it("refuses approvals the owner gate would refuse before encoding", () => {
    expect(gitReceiveApprovalAdmits(approval)).toBe(true);
    // A first publish: all-zero old OID of the source's width.
    expect(gitReceiveApprovalAdmits({ ...approval, expectedOldOid: "0".repeat(40) })).toBe(true);
    for (const change of [
      { repositoryPath: "/srv/other.git" },
      { destinationRef: "refs/tags/v1" },
      { destinationRef: "refs/heads/../x" },
      { destinationRef: "refs/heads/x.lock" },
      { expectedOldOid: "0".repeat(64) },
      { sourceOid: "b".repeat(64) },
      { sourceOid: "B".repeat(40) },
    ]) {
      expect(gitReceiveApprovalAdmits({ ...approval, ...change })).toBe(false);
      expect(() => encode({ kind: "gitReceiveOpen", lease, ...approval, ...change })).toThrow(
        PickerProofOwnerError,
      );
    }
  });
});

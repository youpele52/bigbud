import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  gitUploadAdmits,
  readGitUpload,
  writeGitUpload,
  type GitUploadOperation,
} from "./sshOwnerPickerProof.codec.gitUpload.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const lease = new Uint8Array(32).fill(93);

function encode(operation: GitUploadOperation): string {
  const writer = new WireWriter();
  writeGitUpload(writer, operation);
  return Buffer.from(writer.finish()).toString("hex");
}

describe("U15 Git upload codec", () => {
  it("encodes exactly the golden request operations", () => {
    const open = encode({
      kind: "gitUploadOpen",
      lease,
      workspaceRoot: "/srv/work",
      repositoryPath: "/srv/work/repo.git",
    });
    expect(frames.get("git_upload_open")?.endsWith(open)).toBe(true);
    expect(
      frames.get("git_upload_status")?.endsWith(encode({ kind: "gitUploadStatus", lease })),
    ).toBe(true);
    expect(
      frames.get("git_upload_close")?.endsWith(encode({ kind: "gitUploadClose", lease })),
    ).toBe(true);
  });

  it("decodes the golden listening and exited replies", () => {
    // Reply body = tag 50 (0x92 0x03), length, then the state message.
    const state = (name: string) => {
      const hex = frames.get(name)!;
      const body = hex.slice(hex.indexOf("9203") + 4);
      return Buffer.from(body.slice(2), "hex");
    };
    const listening = readGitUpload(state("git_upload_listening"));
    expect(Array.from(listening.lease)).toEqual(Array.from(lease));
    expect(listening).toMatchObject({
      phase: "listening",
      socketPath: "/tmp/bigbud-oc1-0123456789abcdef/s",
    });
    expect(readGitUpload(state("git_upload_exited"))).toMatchObject({
      phase: "exited",
      exitCode: 0,
    });
  });

  it("refuses paths outside the root before encoding", () => {
    expect(gitUploadAdmits("/srv/work", "/srv/workshop/r.git")).toBe(false);
    expect(gitUploadAdmits("/", "/etc")).toBe(false);
    expect(gitUploadAdmits("/srv/work", "/srv/work/../x")).toBe(false);
    expect(() =>
      encode({
        kind: "gitUploadOpen",
        lease,
        workspaceRoot: "/srv/work",
        repositoryPath: "/srv/other.git",
      }),
    ).toThrow(PickerProofOwnerError);
  });
});

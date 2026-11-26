import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import {
  readWorkspaceEntryOutcome,
  writeWorkspaceEntryOperation,
  type WorkspaceEntryOperation,
} from "./sshOwnerPickerProof.codec.workspaceEntry.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const encode = (operation: WorkspaceEntryOperation) => {
  const writer = new WireWriter();
  writeWorkspaceEntryOperation(writer, operation);
  return Buffer.from(writer.finish()).toString("hex");
};
const outcome = (name: string, tag: string) => {
  const hex = frames.get(name)!;
  return Buffer.from(hex.slice(hex.lastIndexOf(tag) + tag.length + 2), "hex");
};

describe("W2 T-files session-FS entry codec", () => {
  it("encodes exactly the golden request operations", () => {
    const root = "/srv/work";
    expect(
      frames
        .get("workspace_entry_info")
        ?.endsWith(
          encode({ kind: "workspaceEntryInfo", workspaceRoot: root, relativePath: "src/main.rs" }),
        ),
    ).toBe(true);
    expect(
      frames.get("workspace_rename")?.endsWith(
        encode({
          kind: "workspaceRename",
          workspaceRoot: root,
          relativePath: "a.txt",
          destinationPath: "b/a.txt",
        }),
      ),
    ).toBe(true);
    expect(
      frames.get("workspace_append")?.endsWith(
        encode({
          kind: "workspaceAppend",
          workspaceRoot: root,
          relativePath: "log.txt",
          contents: Buffer.from("line\n"),
        }),
      ),
    ).toBe(true);
  });

  it("decodes the golden replies", () => {
    expect(readWorkspaceEntryOutcome(73, outcome("workspace_entry_info_reply", "ca04"))).toEqual({
      kind: "workspaceEntryInfo",
      value: { kind: "file", size: 42, mtimeMs: 1_764_000_000_000, birthtimeMs: 1_763_000_000_000 },
    });
    expect(readWorkspaceEntryOutcome(74, outcome("workspace_entry_change", "d204"))).toEqual({
      kind: "workspaceEntryChange",
      value: "done",
    });
  });

  it("refuses unsafe operands before the wire", () => {
    const root = "/srv/work";
    for (const operation of [
      { kind: "workspaceEntryInfo", workspaceRoot: "/", relativePath: "" },
      { kind: "workspaceEntryInfo", workspaceRoot: root, relativePath: "../x" },
      { kind: "workspaceRename", workspaceRoot: root, relativePath: "a", destinationPath: "a" },
      { kind: "workspaceRename", workspaceRoot: root, relativePath: "a", destinationPath: "/b" },
      {
        kind: "workspaceAppend",
        workspaceRoot: root,
        relativePath: "a",
        contents: new Uint8Array(),
      },
      {
        kind: "workspaceAppend",
        workspaceRoot: root,
        relativePath: "a",
        contents: new Uint8Array(48 * 1024 + 1),
      },
    ] as const)
      expect(() => encode(operation)).toThrow(PickerProofOwnerError);
  });
});

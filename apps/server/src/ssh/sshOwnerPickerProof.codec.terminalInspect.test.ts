import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  isTerminalShellPath,
  writeProofTerminalOperation,
  type ProofTerminalOperation,
} from "./sshOwnerPickerProof.codec.terminal.ts";
import { readTerminalOutcome } from "./sshOwnerPickerProof.codec.terminalOutcome.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const lease = new Uint8Array(32).fill(0x71);

function encode(operation: ProofTerminalOperation): string {
  const writer = new WireWriter();
  writeProofTerminalOperation(writer, new WireWriter(), operation);
  return Buffer.from(writer.finish()).toString("hex");
}

/** The reply's outcome message: after `tag` (varint hex) and a one-byte length. */
const outcome = (name: string, tag: string) => {
  const hex = frames.get(name)!;
  return Buffer.from(hex.slice(hex.lastIndexOf(tag) + tag.length + 2), "hex");
};

describe("W2 T-term terminal_inspect and U16 shell codec", () => {
  it("encodes exactly the golden request operations", () => {
    expect(
      frames.get("terminal_inspect")?.endsWith(encode({ kind: "terminalInspect", lease })),
    ).toBe(true);
    expect(
      frames.get("list_terminal_shells")?.endsWith(encode({ kind: "listTerminalShells" })),
    ).toBe(true);
    const prepare = encode({
      kind: "prepareProofTerminal",
      cwd: "/srv/work",
      threadId: "thread",
      terminalId: "pane",
      cols: 96,
      rows: 34,
      shell: "/usr/bin/zsh",
    });
    expect(frames.get("proof_terminal_prepare_shell")?.endsWith(prepare)).toBe(true);
  });

  it("decodes the golden process snapshot and shell inventory", () => {
    const snapshot = readTerminalOutcome(71, outcome("terminal_processes", "ba04"));
    expect(snapshot).toMatchObject({
      kind: "terminalProcesses",
      value: {
        shellPid: 4242,
        truncated: false,
        processes: [
          { pid: 4242, parentPid: 4200, groupId: 4242, foregroundGroupId: 4300, command: "-zsh" },
          { pid: 4300, parentPid: 4242, command: "vim notes.txt" },
        ],
      },
    });
    expect(readTerminalOutcome(71, outcome("terminal_processes_truncated", "ba04"))).toMatchObject({
      value: { processes: [], truncated: true },
    });
    expect(readTerminalOutcome(72, outcome("terminal_shells", "c204"))).toEqual({
      kind: "terminalShells",
      value: ["/bin/bash", "/usr/bin/zsh"],
    });
  });

  it("refuses an unsafe shell operand before the wire", () => {
    for (const shell of ["zsh", "/bin/../sh", "/bin/sh;id", "/", "/bin//sh"]) {
      expect(isTerminalShellPath(shell)).toBe(false);
      expect(() =>
        encode({
          kind: "prepareProofTerminal",
          cwd: "/srv",
          threadId: "t",
          terminalId: "p",
          cols: 80,
          rows: 24,
          shell,
        }),
      ).toThrow(PickerProofOwnerError);
    }
    expect(() => encode({ kind: "terminalInspect", lease: new Uint8Array(3) })).toThrow(
      PickerProofOwnerError,
    );
  });
});

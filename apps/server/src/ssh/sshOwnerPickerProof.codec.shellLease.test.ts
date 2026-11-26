import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  readShellLease,
  shellLeaseAdmits,
  writeShellLease,
  type ShellLeaseOperation,
} from "./sshOwnerPickerProof.codec.shellLease.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const thread = new Uint8Array(32).fill(90);
const provider = new Uint8Array(32).fill(91);
const acp = new Uint8Array(32).fill(92);

function encode(operation: ShellLeaseOperation): string {
  const writer = new WireWriter();
  writeShellLease(writer, operation);
  return Buffer.from(writer.finish()).toString("hex");
}

/** Reply body = tag 56 (0xc2 0x03), length, then the state message. */
function state(name: string): Uint8Array {
  const hex = frames.get(name)!;
  const body = hex.slice(hex.indexOf("c203") + 4);
  return Buffer.from(body.slice(2), "hex");
}

describe("W2 T-shell production lease codec", () => {
  it("encodes exactly the golden request operations", () => {
    const cases: ReadonlyArray<readonly [string, ShellLeaseOperation]> = [
      [
        "run_thread_shell",
        {
          kind: "runThreadShell",
          lease: thread,
          workspaceRoot: "/srv/work",
          cwd: "/srv/work/sub",
          threadId: "thread-1",
          command: "printf 'thread\\n'",
          timeoutMs: 30_000,
        },
      ],
      [
        "run_provider_workspace_shell",
        {
          kind: "runProviderWorkspaceShell",
          lease: provider,
          workspaceRoot: "/srv/work",
          cwd: "/srv/work",
          provider: "cursor",
          sessionId: "session-1",
          invocationId: "invocation-1",
          command: "printf 'provider\\n'",
          timeoutMs: 30_000,
        },
      ],
      [
        "run_acp_command",
        { kind: "runAcpCommand", lease: acp, workspaceRoot: "/srv/work", cwd: "/srv/work" },
      ],
      [
        "run_acp_shell",
        {
          kind: "runAcpShell",
          lease: new Uint8Array(32).fill(95),
          workspaceRoot: "/srv/work",
          cwd: "/srv/work/sub",
          sessionId: "acp-session-1",
          toolCallId: "tool-call-1",
          command: "ls -la",
          timeoutMs: 30_000,
        },
      ],
      ["shell_status", { kind: "shellStatus", lease: thread, role: "thread", offset: 1_048_576 }],
      ["shell_close", { kind: "shellClose", lease: acp, role: "acp" }],
    ];
    for (const [name, operation] of cases) {
      expect(frames.get(name)?.endsWith(encode(operation)), name).toBe(true);
    }
  });

  it("decodes the golden running, exited and closed replies", () => {
    expect(readShellLease(state("shell_running"))).toMatchObject({
      role: "providerWorkspace",
      phase: "running",
    });
    const exited = readShellLease(state("shell_exited"));
    expect(exited).toMatchObject({
      role: "thread",
      phase: "exited",
      outputSize: 7,
      exitCode: 0,
      truncated: true,
    });
    expect(exited.phase === "exited" && Buffer.from(exited.output).toString()).toBe("thread\n");
    expect(readShellLease(state("shell_closed"))).toMatchObject({ role: "acp", phase: "closed" });
  });

  it("refuses roots, escaping cwds, bad leases and extra operands before dispatch", () => {
    expect(shellLeaseAdmits("/srv/work", "/srv/work/a")).toBe(true);
    for (const [root, cwd] of [
      ["/", "/"],
      ["/srv/work", "/srv/workshop"],
      ["/srv/work", "/srv/work/../x"],
      ["srv/work", "srv/work"],
      ["/srv/work", "/srv/work/a\nb"],
    ] as const) {
      expect(shellLeaseAdmits(root, cwd), `${root} ${cwd}`).toBe(false);
      expect(() => encode({ kind: "runAcpCommand", lease: acp, workspaceRoot: root, cwd })).toThrow(
        PickerProofOwnerError,
      );
    }
    expect(() => encode({ kind: "shellClose", lease: new Uint8Array(31), role: "thread" })).toThrow(
      PickerProofOwnerError,
    );
    expect(() =>
      encode({
        kind: "runProviderWorkspaceShell",
        lease: provider,
        workspaceRoot: "/srv/work",
        cwd: "/srv/work",
        provider: "unknown",
        sessionId: "s",
        invocationId: "i",
        command: "true",
        timeoutMs: 1,
      }),
    ).toThrow(PickerProofOwnerError);
    expect(() =>
      encode({
        kind: "runThreadShell",
        lease: thread,
        workspaceRoot: "/srv/work",
        cwd: "/srv/work",
        threadId: "t",
        command: "true",
        timeoutMs: 120_001,
      }),
    ).toThrow(PickerProofOwnerError);
  });

  it("rejects an exited reply without an exit code or with an oversized chunk", () => {
    const writer = new WireWriter();
    writer.fieldBytes(1, thread);
    writer.fieldUint(2, 1);
    writer.fieldUint(3, 2);
    expect(() => readShellLease(writer.finish())).toThrow();
    const running = new WireWriter();
    running.fieldBytes(1, thread);
    running.fieldUint(2, 1);
    running.fieldUint(3, 1);
    running.fieldBytes(4, new Uint8Array([1]));
    expect(() => readShellLease(running.finish())).toThrow();
  });
});

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { verifyWorkspaceAgentHandshake } from "./workspace-agent-handshake.ts";

describe("packaged workspace agent handshake protocol", () => {
  it("sends the current golden client hello in both authority modes", async () => {
    const goldenFrames = readFileSync(
      new URL("../../protocol/remote-agent/v1.golden.frames", import.meta.url),
      "utf8",
    );
    const helloHex = goldenFrames.match(/^client_hello=(.+)$/m)?.[1];
    expect(helloHex).toBeDefined();
    const requests: Buffer[] = [];
    spawn.mockImplementation((_binary: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      child.stdin.on("data", (frame: Buffer) => {
        requests.push(Buffer.from(frame));
        const capability = args.includes("--resource-cleanup")
          ? "resource.cleanup"
          : "workspace.watch";
        const payload = Buffer.concat([Buffer.from([0x12]), Buffer.from(capability)]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(payload.length);
        child.stdout.write(Buffer.concat([length, payload]));
      });
      return child;
    });

    await verifyWorkspaceAgentHandshake("test-agent");

    expect(requests.map((frame) => frame.toString("hex"))).toEqual([helloHex, helloHex]);
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      ["--ephemeral"],
      ["--resource-cleanup"],
    ]);
  });
});

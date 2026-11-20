import { describe, expect, it } from "vitest";
import { sanitizeTerminalCommand, TerminalWorkSignalReader } from "./terminalWorkSignalReader.ts";

function reader() {
  let now = 1_000;
  const instance = new TerminalWorkSignalReader(() => now);
  return { instance, advance: (ms: number) => (now += ms) };
}

describe("TerminalWorkSignalReader", () => {
  it("reports a finished command with exit code, duration and command line", () => {
    const { instance, advance } = reader();
    expect(instance.receive("$ \u001b]133;C;cmdline_url=npm%20test\u0007output")).toEqual([]);
    advance(70_000);
    expect(instance.receive("\u001b]133;D;1\u0007")).toEqual([
      {
        atMs: 71_000,
        command: "npm test",
        exitCode: 1,
        durationMs: 70_000,
        source: "shell-integration",
      },
    ]);
    expect(instance.shellIntegrationSeen).toBe(true);
  });

  it("parses markers split across chunks and ST terminators", () => {
    const { instance, advance } = reader();
    instance.receive("\u001b]13");
    instance.receive("3;C\u001b");
    instance.receive("\\");
    advance(5);
    const finished = instance.receive("\u001b]133;D;0\u001b\\");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ exitCode: 0, durationMs: 5 });
  });

  it("ignores a D without a fresh C (duplicate integrations, missing start)", () => {
    const { instance } = reader();
    expect(instance.receive("\u001b]133;D;0\u0007")).toEqual([]);
    instance.receive("\u001b]133;C\u0007\u001b]133;C\u0007");
    expect(instance.receive("\u001b]133;D;2\u0007")).toHaveLength(1);
    expect(instance.receive("\u001b]133;D;2\u0007")).toEqual([]);
  });

  it("reports an unknown exit code as null", () => {
    const { instance } = reader();
    instance.receive("\u001b]133;C\u0007");
    expect(instance.receive("\u001b]133;D\u0007")[0]?.exitCode).toBeNull();
    instance.receive("\u001b]133;C\u0007");
    expect(instance.receive("\u001b]133;D;aid=7\u0007")[0]?.exitCode).toBeNull();
  });

  it("matches the agent done marker exactly", () => {
    const { instance } = reader();
    expect(instance.receive("\u001b]777;bigbud;done\u0007")).toEqual([
      { atMs: 1_000, exitCode: null, durationMs: null, source: "agent-hook" },
    ]);
    for (const similar of [
      "\u001b]777;bigbud;done;x\u0007",
      "\u001b]777;bigbud;don\u0007",
      "\u001b]777;notify;bigbud;done\u0007",
      "\u001b]9;bigbud;done\u0007",
      "777;bigbud;done\u0007",
      "\u0007",
    ])
      expect(instance.receive(similar)).toEqual([]);
    expect(instance.shellIntegrationSeen).toBe(false);
  });

  it("drops an oversized OSC body and recovers after CAN", () => {
    const { instance } = reader();
    instance.receive(`\u001b]133;C;cmdline=${"x".repeat(5000)}`);
    instance.receive("\u0018");
    expect(instance.receive("\u001b]777;bigbud;done\u0007")).toHaveLength(1);
  });
});

describe("sanitizeTerminalCommand", () => {
  it("strips control characters and bounds the length", () => {
    expect(sanitizeTerminalCommand("a\u001b[31m\nb", false)).toBe("a [31m b");
    expect(sanitizeTerminalCommand("x".repeat(500), false)).toHaveLength(120);
    expect(sanitizeTerminalCommand("%E0%A4%A", true)).toBeUndefined();
  });
});

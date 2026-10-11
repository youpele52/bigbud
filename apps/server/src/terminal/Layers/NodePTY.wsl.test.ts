import { describe, expect, it } from "vitest";
import { terminalNodePtyArgs } from "./NodePTY.wsl";
import { buildWslTerminalShellCandidate } from "./Manager.wsl.invocation";

// Model the Windows CRT backslash/quote rules without requiring a Windows native PTY on macOS.
function parseWindowsArgs(command: string): string[] {
  const args: string[] = [];
  let offset = 0;
  while (offset < command.length) {
    while (/\s/.test(command[offset] ?? "") && offset < command.length) offset++;
    if (offset >= command.length) break;
    let value = "";
    let quoted = false;
    while (offset < command.length && (quoted || !/\s/.test(command[offset]!))) {
      let slashes = 0;
      while (command[offset] === "\\") {
        slashes++;
        offset++;
      }
      if (command[offset] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"';
        else quoted = !quoted;
        offset++;
      } else {
        value += "\\".repeat(slashes);
        if (offset < command.length) value += command[offset++]!;
      }
    }
    args.push(value);
  }
  return args;
}

describe("WSL-only Windows PTY quoting", () => {
  it("round trips empty, prequoted, hostile, Unicode and trailing-backslash data", () => {
    const args = [
      "",
      '"distro --exec hostile"',
      'x & %PATH% "quoted"',
      "Linux-日本語",
      "C:\\path with spaces\\",
      'a\\\\"b',
      "line\nbreak",
    ];
    expect(parseWindowsArgs(terminalNodePtyArgs(args, "wsl:Ubuntu", "win32") as string)).toEqual(
      args,
    );
  });
  it("round trips the entire fixed-script distro/user/cwd/environment invocation", () => {
    const candidate = buildWslTerminalShellCandidate({
      wslIdentity: { distribution: '"distro --exec hostile"', username: "alice", uid: 1000 },
      cwd: '/project/"quoted & %X%"',
      runtimeEnv: { EXTRA: '"quoted data" & $(echo wrong)' },
    });
    expect(
      parseWindowsArgs(terminalNodePtyArgs(candidate.args!, "wsl:distro", "win32") as string),
    ).toEqual(candidate.args);
  });
  it.each([
    ["local", "win32"],
    ["ssh:host=box", "win32"],
    ["wsl:Ubuntu", "darwin"],
  ] as const)("preserves ordinary argv for %s on %s", (target, platform) => {
    const args = ["-l", "data"];
    expect(terminalNodePtyArgs(args, target, platform)).toBe(args);
  });
});

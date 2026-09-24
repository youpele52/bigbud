import { describe, expect, it } from "vitest";

import {
  agentFromProcessCommand,
  detectAgentForShell,
  parsePosixAgentProcesses,
  parseWindowsAgentProcesses,
} from "./Manager.agentDetection";

describe("terminal agent process detection", () => {
  it("keeps split panes tied to their own foreground processes", () => {
    const processes = parsePosixAgentProcesses(`
      100 1 100 201 /bin/zsh
      101 1 101 202 /bin/zsh
      201 100 201 201 /Users/me/.local/bin/agent
      202 101 202 202 /Users/me/.local/bin/pi
    `);
    expect(detectAgentForShell(100, processes, "posix")).toBe("cursor");
    expect(detectAgentForShell(101, processes, "posix")).toBe("pi");
  });

  it("follows the active foreground group when agents switch in one pane", () => {
    const pi = parsePosixAgentProcesses(`
      100 1 100 201 /bin/zsh
      201 100 201 201 /opt/homebrew/bin/pi
      202 100 202 202 /opt/homebrew/bin/cursor-agent
    `);
    expect(detectAgentForShell(100, pi, "posix")).toBe("pi");

    const opencode = parsePosixAgentProcesses(`
      100 1 100 203 /bin/zsh
      201 100 201 201 /opt/homebrew/bin/pi
      203 100 203 203 /opt/homebrew/bin/opencode
    `);
    expect(detectAgentForShell(100, opencode, "posix")).toBe("opencode");

    const shell = parsePosixAgentProcesses(`
      100 1 100 100 /bin/zsh
      201 100 201 201 /opt/homebrew/bin/pi
    `);
    expect(detectAgentForShell(100, shell, "posix")).toBeNull();
  });

  it("recognizes supported runtime wrappers without matching unrelated output", () => {
    expect(
      agentFromProcessCommand(
        "node /Users/me/.local/share/node_modules/pi-coding-agent/dist/cli.js",
      ),
    ).toBe("pi");
    expect(
      agentFromProcessCommand(
        "/Applications/Cursor.app/Contents/Resources/node /Users/me/cursor-agent/versions/1/index.js",
      ),
    ).toBe("cursor");
    expect(agentFromProcessCommand("rg 'opencode' README.md")).toBeNull();
  });

  it("uses only unambiguous Windows descendants", () => {
    const processes = parseWindowsAgentProcesses(
      JSON.stringify([
        {
          ProcessId: 100,
          ParentProcessId: 1,
          Name: "powershell.exe",
          CommandLine: "powershell.exe",
        },
        { ProcessId: 201, ParentProcessId: 100, Name: "opencode.exe", CommandLine: "opencode.exe" },
      ]),
    );
    expect(detectAgentForShell(100, processes, "windows")).toBe("opencode");

    const ambiguous = parseWindowsAgentProcesses(
      JSON.stringify([
        {
          ProcessId: 100,
          ParentProcessId: 1,
          Name: "powershell.exe",
          CommandLine: "powershell.exe",
        },
        { ProcessId: 201, ParentProcessId: 100, Name: "opencode.exe", CommandLine: "opencode.exe" },
        { ProcessId: 202, ParentProcessId: 100, Name: "pi.exe", CommandLine: "pi.exe" },
      ]),
    );
    expect(detectAgentForShell(100, ambiguous, "windows")).toBeNull();
  });
});

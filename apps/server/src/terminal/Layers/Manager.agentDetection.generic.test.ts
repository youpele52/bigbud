import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TERMINAL_AGENTS, type TerminalAgentDescriptor } from "../terminalAgents.ts";
import {
  createTerminalAgentDetector,
  createTerminalAgentProcessMatcher,
  detectTerminalAgentForShell,
  parsePosixAgentProcesses,
  parseWindowsAgentProcesses,
} from "./Manager.agentDetection.ts";

const fictional: TerminalAgentDescriptor = {
  id: "nebula-worker",
  names: ["Nebula Worker"],
  executables: ["nebula-worker"],
  scriptPaths: ["/nebula-worker/"],
};
const match = createTerminalAgentProcessMatcher([...TERMINAL_AGENTS, fictional]);
const foreground = (command: string) =>
  parsePosixAgentProcesses(`
  100 1 100 200 /bin/zsh
  200 100 200 200 ${command}
`);

describe("generic foreground agent detection", () => {
  it.each([
    "/opt/bin/nebula-worker --task auth",
    "node /modules/nebula-worker/cli.js",
    "bun /modules/nebula-worker/cli.js",
  ])("detects terminal-only metadata from %s", (command) => {
    expect(detectTerminalAgentForShell(100, foreground(command), "posix", match)).toEqual({
      agent: { id: fictional.id, names: fictional.names },
      provider: null,
    });
  });

  it("does not mistake unregistered tools, ordinary searches, or background agents for foreground evidence", () => {
    for (const command of [
      "mystery-agent --task auth",
      "rg /nebula-worker/ README.md",
      "bun dev",
      "git status",
    ]) {
      expect(detectTerminalAgentForShell(100, foreground(command), "posix", match)).toBeNull();
    }
    const background = parsePosixAgentProcesses(
      `100 1 100 100 /bin/zsh\n200 100 200 200 nebula-worker`,
    );
    expect(detectTerminalAgentForShell(100, background, "posix", match)).toBeNull();
  });

  it("keeps ambiguous native and terminal-only identities unlabeled", () => {
    const processes = parseWindowsAgentProcesses(
      JSON.stringify([
        { ProcessId: 100, ParentProcessId: 1, Name: "powershell.exe" },
        { ProcessId: 200, ParentProcessId: 100, Name: "nebula-worker.exe" },
        { ProcessId: 201, ParentProcessId: 100, Name: "codex.exe" },
      ]),
    );
    expect(detectTerminalAgentForShell(100, processes, "windows", match)).toBeNull();
    expect(
      detectTerminalAgentForShell(100, processes.slice(0, 2), "windows", match)?.agent.id,
    ).toBe(fictional.id);
  });

  it("uses one process inspection for multiple terminals and no inspection for an empty batch", async () => {
    let scans = 0;
    const detector = createTerminalAgentDetector({
      agents: [...TERMINAL_AGENTS, fictional],
      inspect: () =>
        Effect.sync(() => {
          scans++;
          return {
            platform: "posix" as const,
            processes: parsePosixAgentProcesses(`
        100 1 100 200 /bin/zsh
        200 100 200 200 nebula-worker
        101 1 101 201 /bin/zsh
        201 101 201 201 codex
      `),
          };
        }),
    });
    expect((await Effect.runPromise(detector([]))).size).toBe(0);
    expect(scans).toBe(0);
    const detected = await Effect.runPromise(detector([100, 101, 999]));
    expect(scans).toBe(1);
    expect(detected.get(100)).toMatchObject({ agent: { id: fictional.id }, provider: null });
    expect(detected.get(101)).toMatchObject({ agent: { id: "codex" }, provider: "codex" });
    expect(detected.get(999)).toBeNull();
  });
});

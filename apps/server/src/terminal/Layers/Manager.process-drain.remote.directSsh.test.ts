/**
 * Direct SSH through the local terminal host (plan M7): the PTY is a local ssh client in the host
 * (a host PID with `pidDomain = "remote"`), so remote inspection must still target the SSH host,
 * read the in-band shell PID, and push the owner hint with every view-state push.
 */
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";

import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import type { PtyViewState } from "../Services/PTY.ts";
import {
  parsePosixAgentProcesses,
  TerminalAgentInspectionError,
} from "./Manager.agentDetection.ts";
import { pushTerminalHostViewState } from "./Manager.hostPolicy.ts";
import { TerminalHostOutputLedger } from "./Manager.hostScreen.ledger.ts";
import { pollSubprocessActivityWith } from "./Manager.process-drain.poll.ts";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle.ts";
import { remoteOwnerBusyHint } from "./Manager.remote-inspection.ts";
import { createTerminalSessionState } from "./Manager.session.state.ts";
import { toSessionKey } from "./Manager.shell.ts";
import type { TerminalManagerState, TerminalSessionState } from "./Manager.types.ts";
import { FakePtyProcess } from "./Manager.test.helpers.ts";
import {
  terminalPidIsOnBackendHost,
  terminalRunsLocalSshClient,
  terminalShellPidIsInBand,
} from "./OwnedPtyRuntime.identity.ts";

const target = "ssh:host=devbox&auth=ssh-key&transport=direct-ssh";
const sshClient = { status: async () => "live" as const, close: async () => {} };
const hostRuntime = {
  targetId: "local-terminal-host",
  pidNamespace: "backend-host",
  localSshClient: sshClient,
} as unknown as OwnedPtyRuntime;
const adapter = {
  spawn: () => Effect.die("unused"),
  ownedRuntimeForTarget: (candidate: string) => (candidate === target ? hostRuntime : undefined),
};

function hostSession(remoteShellPid: number | undefined) {
  const viewStates: PtyViewState[] = [];
  const process = Object.assign(new FakePtyProcess(31_000), {
    pidDomain: "remote" as const,
    lifecycle: {
      setViewState: async (state: PtyViewState) => {
        viewStates.push(state);
      },
    },
  });
  const session = Object.assign(
    createTerminalSessionState({
      threadId: "thread",
      terminalId: "ssh",
      executionTargetId: target,
      dropPathMode: "posix",
      cwd: "/srv",
      worktreePath: null,
      history: "",
      cols: 80,
      rows: 24,
      runtimeEnv: null,
    }),
    { status: "running" as const, pid: 31_000, remoteShellPid },
  ) as TerminalSessionState & { pid: number };
  session.process = process as unknown as TerminalSessionState["process"];
  session.host = {
    generation: session.runtimeGeneration,
    ptyId: "pty-1",
    ledger: new TerminalHostOutputLedger(),
    screen: true,
    restorable: true,
    lifecycle: true,
    ownerBusyHint: "unknown",
  };
  return { session, viewStates };
}

function fixture(session: TerminalSessionState & { pid: number }, processes: string) {
  let state: TerminalManagerState = {
    sessions: new Map([[toSessionKey(session.threadId, session.terminalId), session]]),
    killFibers: new Map(),
  };
  const viewChanged = vi.fn();
  const remoteProcessInspector = vi.fn((_target: string) =>
    Effect.succeed(parsePosixAgentProcesses(processes)),
  );
  const ctx = {
    readManagerState: Effect.sync(() => state),
    agentDetector: vi.fn(() => Effect.succeed(new Map())),
    subprocessChecker: vi.fn(() => Effect.succeed(false)),
    remoteProcessInspector,
    ptyAdapter: adapter,
    hostHub: { viewChanged },
    modifyManagerState: (
      f: (state: TerminalManagerState) => readonly [unknown, TerminalManagerState],
    ) =>
      Effect.sync(() => {
        const [value, next] = f(state);
        state = next;
        return value;
      }),
    publishEvent: (_event: TerminalEvent) => Effect.void,
  } as unknown as ProcessLifecycleContext;
  return { ctx, viewChanged, remoteProcessInspector };
}

describe("Direct SSH PTYs in the local terminal host", () => {
  it("classifies the local ssh client as an SSH pane, not a backend-host process", () => {
    expect(terminalRunsLocalSshClient(adapter, target)).toBe(true);
    expect(terminalRunsLocalSshClient(adapter, "local")).toBe(false);
    expect(terminalPidIsOnBackendHost(adapter, target, { pidDomain: "remote" })).toBe(false);
    expect(terminalShellPidIsInBand(adapter, target, { pidDomain: "remote" })).toBe(true);
    // Without the host, an in-process ssh client reads its marker exactly as before.
    expect(terminalShellPidIsInBand(undefined, target, {})).toBe(true);
    expect(terminalShellPidIsInBand(undefined, target, { pidDomain: "remote" })).toBe(false);
    expect(terminalShellPidIsInBand(adapter, "local", {})).toBe(false);
  });

  it("inspects the SSH host with the in-band shell PID and pushes the busy hint", async () => {
    const { session } = hostSession(100);
    const f = fixture(session, "100 1 100 200 -zsh\n200 100 200 200 vim notes.md");
    await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
    expect(f.remoteProcessInspector).toHaveBeenCalledExactlyOnceWith(target);
    expect(session.hasRunningSubprocess).toBe(true);
    expect(session.host?.ownerBusyHint).toBe("busy");
    expect(f.viewChanged).toHaveBeenCalledWith("thread", "ssh");
  });

  it("pushes idle at a prompt and unknown when inspection fails", async () => {
    const { session } = hostSession(100);
    const f = fixture(session, "100 1 100 100 -zsh");
    await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
    expect(session.host?.ownerBusyHint).toBe("idle");
    f.ctx.remoteProcessInspector = () =>
      Effect.fail(new TerminalAgentInspectionError({ message: "offline" }));
    await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
    expect(session.host?.ownerBusyHint).toBe("unknown");
    expect(f.viewChanged).toHaveBeenCalledTimes(2);
  });

  it("never inspects without the shell PID, so the hint stays unknown (busy)", async () => {
    const { session } = hostSession(undefined);
    const f = fixture(session, "100 1 100 100 -zsh");
    await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
    expect(f.remoteProcessInspector).not.toHaveBeenCalled();
    expect(session.host?.ownerBusyHint).toBe("unknown");
  });

  it("carries the hint in every view-state push, so the host never loses it", async () => {
    const { session, viewStates } = hostSession(100);
    const log = vi.fn();
    pushTerminalHostViewState(session, { viewState: "hidden", rendererAttached: false }, log);
    session.host!.ownerBusyHint = "idle";
    pushTerminalHostViewState(session, { viewState: "hidden", rendererAttached: false }, log);
    session.host!.ownerBusyHint = undefined;
    pushTerminalHostViewState(session, { viewState: "visible", rendererAttached: true }, log);
    await Promise.resolve();
    expect(viewStates.map((state) => state.ownerBusyHint)).toEqual(["unknown", "idle", undefined]);
  });
});

describe("remote owner hint (plan §8.5)", () => {
  const hint = (processes: string) => remoteOwnerBusyHint(100, parsePosixAgentProcesses(processes));

  it("is idle at the shell's prompt and at a nested shell's prompt", () => {
    expect(hint("100 1 100 100 -bash")).toBe("idle");
    expect(hint("100 1 100 300 -bash\n300 100 300 300 /usr/bin/zsh -l")).toBe("idle");
  });

  it("is busy for a foreground program, a program inside a nested shell, or an unknown leader", () => {
    expect(hint("100 1 100 200 zsh\n200 100 200 200 /usr/bin/ssh other")).toBe("busy");
    expect(hint("100 1 100 400 zsh\n300 100 300 400 bash\n400 300 400 400 vim")).toBe("busy");
    expect(hint("100 1 100 777 zsh")).toBe("busy");
  });

  it("is unknown without the shell or its terminal facts; background jobs never count", () => {
    expect(hint("1 0 1 -1 init")).toBe("unknown");
    expect(hint("100 1 100 -1 zsh")).toBe("unknown");
    expect(hint("100 1 100 100 zsh\n200 100 200 100 sleep 100")).toBe("idle");
  });
});

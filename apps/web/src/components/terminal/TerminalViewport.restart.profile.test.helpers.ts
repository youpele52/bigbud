import type { Terminal } from "@xterm/xterm";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { vi, type Mock } from "vitest";
import type { TerminalProfileReplacement } from "./TerminalProfilePicker.restart";
import { makeTerminalRestartAction } from "./TerminalViewport.restart";

export const host = { kind: "ssh", hostId: "ssh:profile" } as const;
export const old: TerminalSessionSnapshot = {
  threadId: "profile-restart",
  terminalId: "pane",
  cwd: "/remote/project",
  worktreePath: null,
  executionTargetId: "ssh:profile",
  runtimeEnv: { SOURCE: "pane" },
  dropPathMode: "posix",
  status: "running",
  pid: 1,
  history: "output",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-11-11T00:00:00Z",
  runtimeGeneration: "old",
  shellLaunchIdentity: {
    host,
    selection: { kind: "profile", profileId: "zsh" },
    profileId: "zsh",
    kind: "zsh",
    integration: { status: "disabled" },
  },
};
export const fresh: TerminalSessionSnapshot = {
  ...old,
  runtimeGeneration: "fresh",
  updatedAt: "2026-11-11T00:00:01Z",
};
type FixtureDelivery = {
  intake: {
    hydrate: Mock<(snapshot: TerminalSessionSnapshot) => Promise<void>>;
    pause: Mock<() => void>;
  };
};
type FixtureInput = Omit<
  Parameters<typeof makeTerminalRestartAction>[0],
  "prepare" | "isCurrent" | "readSnapshot"
> & {
  prepare: Mock<(isCurrent?: () => boolean) => Promise<FixtureDelivery | undefined>>;
  isCurrent: () => boolean;
  readSnapshot: () => TerminalSessionSnapshot;
};
interface RestartFixture {
  action: ReturnType<typeof makeTerminalRestartAction>;
  input: FixtureInput;
  replacement: TerminalProfileReplacement;
  confirm: Mock<() => Promise<boolean>>;
  restart: Mock<(request: unknown) => Promise<TerminalSessionSnapshot>>;
  snapshotRpc: Mock<() => Promise<TerminalSessionSnapshot>>;
  prepare: FixtureInput["prepare"];
  hydrate: FixtureDelivery["intake"]["hydrate"];
  pause: FixtureDelivery["intake"]["pause"];
  delivery: FixtureDelivery;
  onFailure: Mock<() => void>;
}

export function fixture(): RestartFixture {
  let snapshot = old;
  const confirm = vi.fn(async () => true);
  const restart = vi.fn(async (_request: unknown) => fresh);
  const snapshotRpc = vi.fn(async () => fresh);
  const hydrate = vi.fn(async (_snapshot: TerminalSessionSnapshot) => {});
  const pause = vi.fn();
  const delivery = { intake: { hydrate, pause } };
  const prepare = vi.fn(
    async (_isCurrent?: () => boolean) => delivery as typeof delivery | undefined,
  );
  const onFailure = vi.fn();
  const input = {
    api: {
      terminal: { restart, snapshot: snapshotRpc },
      dialogs: { confirm },
    } as unknown as NativeApi,
    terminal: { cols: 80, rows: 24 } as Terminal,
    readSnapshot: () => snapshot,
    disposed: () => false,
    prepare,
    isCurrent: () => true,
    onSnapshot: (next: TerminalSessionSnapshot) => {
      snapshot = next;
    },
    onFailure,
  };
  const action = makeTerminalRestartAction(
    input as unknown as Parameters<typeof makeTerminalRestartAction>[0],
  );
  const replacement: TerminalProfileReplacement = {
    profile: { host, shellSelection: { kind: "profile", profileId: "bash" } },
    expectedGeneration: "old",
    isCurrent: () => true,
  };
  return {
    action,
    input,
    replacement,
    confirm,
    restart,
    snapshotRpc,
    prepare,
    hydrate,
    pause,
    delivery,
    onFailure,
  };
}

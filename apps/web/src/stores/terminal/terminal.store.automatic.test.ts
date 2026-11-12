import { afterEach, expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useTerminalStateStore } from "./terminal.store";
import { terminalPersistenceOptions } from "./terminal.store.persistence";
import { terminalProfileKey, captureTerminalProfileLaunch } from "../../lib/terminalProfileLaunch";
import {
  bindTerminalLaunch,
  forgetTerminalLaunch,
  readTerminalLaunch,
  recordTerminalLaunch,
} from "../../lib/terminalLaunchBinding";
import { terminalProfileOpenOptions } from "../../components/terminal/TerminalViewport.profile";
const threadId = ThreadId.makeUnsafe("automatic-test");
const sourceId = "original";
const context = {
  cwd: "/original/work",
  executionTargetId: "ssh:original&transport=direct-ssh",
  worktreePath: null,
  runtimeEnv: { LANG: "C" },
};
const host = { kind: "ssh", hostId: "ssh:original-host" } as const;
afterEach(() => {
  useTerminalStateStore.setState(useTerminalStateStore.getInitialState(), true);
  forgetTerminalLaunch(threadId, sourceId);
});
it.each(["pending", "unconfirmed", "reload"])(
  "explicit Automatic preserves the %s source and target",
  (mode) => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(threadId, sourceId);
    const original = {
      shellSelection: { kind: "profile", profileId: "exact" } as const,
      host,
      context,
    };
    useTerminalStateStore.setState({
      terminalProfileLaunches: { [terminalProfileKey(threadId, sourceId)]: original },
    });
    if (mode === "pending") bindTerminalLaunch(threadId, sourceId, context);
    if (mode === "unconfirmed")
      recordTerminalLaunch({
        threadId,
        terminalId: sourceId,
        ...context,
        status: "running",
        pid: 10,
        history: "retained",
        exitCode: null,
        exitSignal: null,
        dropPathMode: "posix",
        updatedAt: "2026-11-11T00:00:00Z",
        runtimeGeneration: "original-generation",
        shellUnconfirmedLaunch: {
          status: "unconfirmed",
          requestedProfile: { host, profileId: "exact", kind: "zsh" },
        },
      });
    if (mode === "reload")
      useTerminalStateStore.setState(
        terminalPersistenceOptions.merge(
          terminalPersistenceOptions.partialize(useTerminalStateStore.getState()),
          useTerminalStateStore.getInitialState(),
        ),
        true,
      );
    const before = readTerminalLaunch(threadId, sourceId);
    const originalRequest =
      useTerminalStateStore.getState().terminalProfileLaunches[
        terminalProfileKey(threadId, sourceId)
      ];
    const fresh = `terminal-${crypto.randomUUID()}`;
    useTerminalStateStore.getState().newTerminal(threadId, fresh, {
      shellSelection: { kind: "legacy-auto" },
      source: { terminalId: sourceId, runtimeGeneration: before?.runtimeGeneration },
    });
    const saved = useTerminalStateStore.getState();
    expect(saved.terminalStateByThreadId[threadId]?.terminalIds).toContain(sourceId);
    expect(saved.terminalStateByThreadId[threadId]?.terminalIds).toContain(fresh);
    expect(saved.terminalProfileLaunches[terminalProfileKey(threadId, sourceId)]).toBe(
      originalRequest,
    );
    expect(saved.terminalProfileLaunches[terminalProfileKey(threadId, fresh)]).toMatchObject({
      shellSelection: { kind: "legacy-auto" },
      context,
    });
    expect(readTerminalLaunch(threadId, sourceId)).toBe(before);
    expect(readTerminalLaunch(threadId, fresh)).toBeUndefined();
    expect(terminalProfileOpenOptions(threadId, fresh)).toEqual({
      shellSelection: { kind: "legacy-auto" },
    });
    expect(terminalProfileOpenOptions(threadId, sourceId)).toEqual(
      mode === "unconfirmed" ? {} : { shellSelection: { kind: "profile", profileId: "exact" } },
    );
  },
);
it("rejects missing context and stale source provenance rather than selecting current workspace", () => {
  expect(() =>
    captureTerminalProfileLaunch(threadId, sourceId, { shellSelection: { kind: "legacy-auto" } }),
  ).toThrow("original terminal context");
  bindTerminalLaunch(threadId, sourceId, { ...context, runtimeGeneration: "new" });
  expect(() =>
    captureTerminalProfileLaunch(threadId, sourceId, {
      shellSelection: { kind: "legacy-auto" },
      source: { terminalId: sourceId, runtimeGeneration: "old" },
    }),
  ).toThrow("source terminal changed");
});

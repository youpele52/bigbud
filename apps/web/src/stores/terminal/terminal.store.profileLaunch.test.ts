import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindTerminalLaunch,
  forgetTerminalLaunch,
  recordTerminalLaunch,
  readTerminalLaunch,
} from "../../lib/terminalLaunchBinding";
import { captureTerminalProfileLaunch, terminalProfileKey } from "../../lib/terminalProfileLaunch";
import {
  recordTerminalProfileSnapshot,
  terminalProfileOpenOptions,
} from "../../components/terminal/TerminalViewport.profile";
import { createDefaultThreadTerminalState } from "./helpers.store";
import { useTerminalStateStore } from "./terminal.store";
import { terminalPersistenceOptions } from "./terminal.store.persistence";

const threadId = ThreadId.makeUnsafe("profile-launch-test");
const pane = createDefaultThreadTerminalState().activeTerminalId;
const host = { kind: "ssh", hostId: "ssh:remote" } as const;
const snapshot: TerminalSessionSnapshot = {
  threadId,
  terminalId: pane,
  cwd: "/remote/work",
  worktreePath: null,
  executionTargetId: "ssh:remote",
  status: "running",
  pid: 2,
  history: "",
  exitCode: null,
  exitSignal: null,
  dropPathMode: "posix",
  updatedAt: "2026-11-11T00:00:00Z",
  runtimeGeneration: "one",
  shellLaunchIdentity: {
    host,
    selection: { kind: "profile", profileId: "remote-zsh" },
    profileId: "remote-zsh",
    kind: "zsh",
    integration: { status: "disabled" },
  },
};
const options = (id: string) =>
  useTerminalStateStore.getState().terminalProfileLaunches[terminalProfileKey(threadId, id)];
beforeEach(() =>
  useTerminalStateStore.setState({
    terminalProfileLaunches: {},
    terminalStateByThreadId: { [threadId]: createDefaultThreadTerminalState() },
    panelTerminalStateByThreadId: {},
  }),
);
afterEach(() => {
  for (const id of [pane, "new", "split", "panel"]) forgetTerminalLaunch(threadId, id);
});

describe("per-pane profile launch requests", () => {
  it("captures actual profile, host and cwd before changing active pane, not settings", () => {
    recordTerminalLaunch(snapshot);
    useTerminalStateStore.getState().newTerminal(threadId, "new");
    expect(options("new")).toMatchObject({
      shellSelection: { kind: "profile", profileId: "remote-zsh" },
      host,
      context: { cwd: "/remote/work", executionTargetId: "ssh:remote" },
    });
    expect(readTerminalLaunch(threadId, "new")).toBeUndefined();
    useTerminalStateStore.getState().setActiveTerminal(threadId, pane);
    useTerminalStateStore.getState().splitTerminal(threadId, "split");
    expect(options("split")).toEqual(options("new"));
    expect(terminalProfileOpenOptions(threadId, "new")).toEqual({
      shellSelection: { kind: "profile", profileId: "remote-zsh" },
    });
  });
  it.each([false, true])("inherits a visible legacy pane on panel=%s", (panel) => {
    const original = {
      ...snapshot,
      executionTargetId: "local",
      cwd: "/local/project",
      runtimeEnv: { PROJECT_MODE: "source" },
      shellLaunchIdentity: {
        ...snapshot.shellLaunchIdentity!,
        host: { kind: "local" as const, hostId: "local" },
        selection: { kind: "legacy-auto" as const },
        profileId: null,
      },
    };
    recordTerminalLaunch(original);
    const store = useTerminalStateStore.getState();
    if (panel) store.splitPanelTerminal(threadId, "split");
    else store.splitTerminal(threadId, "split");
    expect(options("split")).toMatchObject({
      shellSelection: { kind: "legacy-auto" },
      host: { kind: "local", hostId: "local" },
      context: {
        cwd: "/local/project",
        executionTargetId: "local",
        runtimeEnv: { PROJECT_MODE: "source" },
      },
    });
    expect(terminalProfileOpenOptions(threadId, "split")).toEqual({
      shellSelection: { kind: "legacy-auto" },
    });
  });

  it.each([false, true])(
    "retains downward layout, inheritance and close recovery on panel=%s",
    (panel) => {
      recordTerminalLaunch(snapshot);
      const store = useTerminalStateStore.getState();
      if (panel) store.splitPanelTerminal(threadId, "split", undefined, "down");
      else store.splitTerminal(threadId, "split", undefined, "down");
      const field = panel ? "panelTerminalStateByThreadId" : "terminalStateByThreadId";
      const group = useTerminalStateStore.getState()[field][threadId]!.terminalGroups[0]!;
      expect(group.layout).toEqual({
        direction: "down",
        first: { terminalId: pane },
        second: { terminalId: "split" },
      });
      expect(options("split")?.context?.executionTargetId).toBe(snapshot.executionTargetId);
      if (!panel) {
        const saved = terminalPersistenceOptions.partialize(useTerminalStateStore.getState());
        const restored = terminalPersistenceOptions.merge(
          JSON.parse(JSON.stringify(saved)),
          useTerminalStateStore.getState(),
        );
        expect(restored[field][threadId]!.terminalGroups[0]!.layout).toEqual(group.layout);
      }
    },
  );

  it("inherits pending explicit selection before the first snapshot", () => {
    recordTerminalLaunch(snapshot);
    const store = useTerminalStateStore.getState();
    store.newTerminal(threadId, "new", {
      host,
      shellSelection: { kind: "profile", profileId: "remote-bash" },
    });
    bindTerminalLaunch(threadId, "new", options("new")!.context!);
    store.splitTerminal(threadId, "split");
    expect(options("split")).toMatchObject({
      host,
      shellSelection: { kind: "profile", profileId: "remote-bash" },
      context: { cwd: snapshot.cwd },
    });
    expect(readTerminalLaunch(threadId, "new")?.shellLaunchIdentity).toBeUndefined();
  });

  it("forwards an explicit profile only to the new pane, without marking requested as actual", () => {
    recordTerminalLaunch(snapshot);
    useTerminalStateStore.getState().newTerminal(threadId, "new", {
      host,
      shellSelection: { kind: "profile", profileId: "remote-bash" },
    });
    expect(terminalProfileOpenOptions(threadId, "new")).toEqual({
      shellSelection: { kind: "profile", profileId: "remote-bash" },
    });
    expect(readTerminalLaunch(threadId, pane)?.shellLaunchIdentity?.profileId).toBe("remote-zsh");
    expect(readTerminalLaunch(threadId, "new")?.shellLaunchIdentity).toBeUndefined();
  });
  it.each(["unknown", "unconfirmed"])(
    "inherits %s launch context without requiring a profile choice",
    (kind) => {
      recordTerminalLaunch({
        ...snapshot,
        shellLaunchIdentity: undefined,
        ...(kind === "unconfirmed"
          ? {
              shellUnconfirmedLaunch: {
                status: "unconfirmed" as const,
                requestedProfile: { host, profileId: "remote-zsh", kind: "zsh" as const },
              },
            }
          : {}),
      });
      const inherited = captureTerminalProfileLaunch(threadId, pane);
      expect(inherited.requiresChoice).toBeUndefined();
      expect(inherited.context).toMatchObject({
        cwd: snapshot.cwd,
        executionTargetId: snapshot.executionTargetId,
      });
      expect(terminalProfileOpenOptions(threadId, pane)).toEqual({});
      useTerminalStateStore.getState().newTerminal(threadId, "new");
      expect(terminalProfileOpenOptions(threadId, "new")).toEqual(
        kind === "unconfirmed"
          ? { shellSelection: { kind: "profile", profileId: "remote-zsh" } }
          : {},
      );
      useTerminalStateStore.getState().setActiveTerminal(threadId, pane);
      useTerminalStateStore.getState().splitTerminal(threadId, "split");
      expect(options("split")).toEqual(inherited);
      expect(readTerminalLaunch(threadId, "split")?.shellLaunchIdentity).toBeUndefined();
      expect(
        captureTerminalProfileLaunch(threadId, pane, {
          host,
          shellSelection: { kind: "profile", profileId: "remote-bash" },
        }).shellSelection,
      ).toEqual({ kind: "profile", profileId: "remote-bash" });
    },
  );
  it("uses proven WSL distro rather than a changed new-terminal preference", () => {
    recordTerminalLaunch({
      ...snapshot,
      executionTargetId: "wsl:OldDefault",
      shellLaunchIdentity: {
        ...snapshot.shellLaunchIdentity!,
        host: { kind: "wsl", hostId: "wsl:pinned", distribution: "Pinned", username: "user" },
      },
    });
    expect(captureTerminalProfileLaunch(threadId, pane).context?.executionTargetId).toBe(
      "wsl:Pinned",
    );
    expect(() =>
      captureTerminalProfileLaunch(threadId, pane, {
        host,
        shellSelection: { kind: "profile", profileId: "remote-zsh" },
      }),
    ).toThrow("host changed");
  });
  it("supports both panel actions and cleans requests on close", () => {
    recordTerminalLaunch(snapshot);
    useTerminalStateStore.setState({
      panelTerminalStateByThreadId: { [threadId]: createDefaultThreadTerminalState() },
    });
    useTerminalStateStore.getState().splitPanelTerminal(threadId, "panel");
    expect(options("panel")?.host).toEqual(host);
    useTerminalStateStore.getState().closePanelTerminal(threadId, "panel");
    expect(options("panel")).toBeUndefined();
  });
  it.each(["clearTerminalState", "removeTerminalState", "removeOrphanedTerminalStates"] as const)(
    "cleans saved requests with %s",
    (action) => {
      recordTerminalLaunch(snapshot);
      useTerminalStateStore.getState().newTerminal(threadId, "new");
      if (action === "removeOrphanedTerminalStates")
        useTerminalStateStore.getState()[action](new Set());
      else useTerminalStateStore.getState()[action](threadId);
      expect(options("new")).toBeUndefined();
    },
  );
  it("rejects stale inventory provenance even when the new active pane is on the same host", () => {
    recordTerminalLaunch(snapshot);
    const profile = {
      host,
      shellSelection: { kind: "profile" as const, profileId: "remote-bash" },
      source: { terminalId: pane, runtimeGeneration: "one" },
    };
    expect(() => captureTerminalProfileLaunch(threadId, "another", profile)).toThrow(
      "source terminal changed",
    );
    recordTerminalLaunch({
      ...snapshot,
      updatedAt: "2026-11-11T00:00:01Z",
      runtimeGeneration: "two",
    });
    expect(() => captureTerminalProfileLaunch(threadId, pane, profile)).toThrow(
      "source terminal changed",
    );
  });
  it("persists requests separately from actual evidence and preserves legacy data", () => {
    recordTerminalLaunch(snapshot);
    useTerminalStateStore.getState().newTerminal(threadId, "new");
    const saved = terminalPersistenceOptions.partialize(useTerminalStateStore.getState());
    expect(saved.terminalProfileLaunches).toMatchObject({
      [terminalProfileKey(threadId, "new")]: { host },
    });
    expect(JSON.stringify(saved)).not.toContain("shellLaunchIdentity");
    expect(
      terminalPersistenceOptions.merge({}, useTerminalStateStore.getState())
        .terminalProfileLaunches,
    ).toEqual({});
    expect(
      terminalPersistenceOptions.merge(saved, useTerminalStateStore.getState())
        .terminalProfileLaunches,
    ).toEqual(saved.terminalProfileLaunches);
  });
  it.each(["snapshot", "event"])(
    "reconciles accepted %s evidence across reload without replaying the old profile",
    (via) => {
      recordTerminalLaunch(snapshot);
      useTerminalStateStore.getState().newTerminal(threadId, "new");
      const next: TerminalSessionSnapshot = {
        ...snapshot,
        terminalId: "new",
        runtimeGeneration: "two",
        updatedAt: "2026-11-11T00:00:01Z",
        cwd: "/remote/confirmed",
        shellLaunchIdentity: {
          ...snapshot.shellLaunchIdentity!,
          selection: { kind: "profile", profileId: "remote-bash" },
          profileId: "remote-bash",
          kind: "bash",
        },
      };
      if (via === "snapshot") recordTerminalProfileSnapshot(next);
      else
        useTerminalStateStore.getState().applyTerminalEvent({
          type: "restarted",
          threadId,
          terminalId: "new",
          snapshot: next,
          createdAt: next.updatedAt,
        });
      const saved = terminalPersistenceOptions.partialize(useTerminalStateStore.getState());
      expect(JSON.stringify(saved)).not.toContain("shellLaunchIdentity");
      forgetTerminalLaunch(threadId, "new");
      useTerminalStateStore.setState(
        terminalPersistenceOptions.merge(saved, useTerminalStateStore.getState()),
      );
      expect(terminalProfileOpenOptions(threadId, "new")).toEqual({
        shellSelection: { kind: "profile", profileId: "remote-bash" },
      });
      expect(options("new")?.context?.cwd).toBe("/remote/confirmed");
      expect(readTerminalLaunch(threadId, "new")).toBeUndefined();
    },
  );
  it.each(["unconfirmed", "unknown"])(
    "retires old intent after an authoritative %s outcome without inferring actual identity",
    (kind) => {
      recordTerminalLaunch(snapshot);
      useTerminalStateStore.getState().newTerminal(threadId, "new");
      recordTerminalProfileSnapshot({
        ...snapshot,
        terminalId: "new",
        runtimeGeneration: "two",
        updatedAt: "2026-11-11T00:00:01Z",
        shellLaunchIdentity: undefined,
        ...(kind === "unconfirmed"
          ? {
              shellUnconfirmedLaunch: {
                status: "unconfirmed" as const,
                requestedProfile: { host, profileId: "remote-bash", kind: "bash" as const },
              },
            }
          : {}),
      });
      expect(options("new")?.shellSelection).toEqual(
        kind === "unconfirmed" ? { kind: "profile", profileId: "remote-bash" } : undefined,
      );
      expect(captureTerminalProfileLaunch(threadId, "new").shellSelection).toEqual(
        kind === "unconfirmed" ? { kind: "profile", profileId: "remote-bash" } : undefined,
      );
      expect(readTerminalLaunch(threadId, "new")?.shellLaunchIdentity).toBeUndefined();
      forgetTerminalLaunch(threadId, "new");
      expect(terminalProfileOpenOptions(threadId, "new")).toEqual(
        kind === "unconfirmed"
          ? { shellSelection: { kind: "profile", profileId: "remote-bash" } }
          : {},
      );
    },
  );
  it("ignores stale outcomes and retains the persisted slice for unchanged snapshots", () => {
    const next = { ...snapshot, updatedAt: "2026-11-11T00:00:01Z" };
    recordTerminalProfileSnapshot(next);
    const saved = useTerminalStateStore.getState().terminalProfileLaunches;
    recordTerminalProfileSnapshot(next);
    expect(useTerminalStateStore.getState().terminalProfileLaunches).toBe(saved);
    recordTerminalProfileSnapshot({ ...snapshot, shellLaunchIdentity: undefined });
    useTerminalStateStore.getState().hydrateTerminalAgentFromSnapshot(snapshot);
    expect(useTerminalStateStore.getState().terminalProfileLaunches).toBe(saved);
  });
  it("uses a subsequent actual snapshot over a prior requested profile on reattach", () => {
    recordTerminalLaunch(snapshot);
    useTerminalStateStore.getState().newTerminal(threadId, "new");
    recordTerminalLaunch({
      ...snapshot,
      terminalId: "new",
      shellLaunchIdentity: {
        ...snapshot.shellLaunchIdentity!,
        selection: { kind: "profile", profileId: "remote-fish" },
        profileId: "remote-fish",
        kind: "fish",
      },
    });
    expect(terminalProfileOpenOptions(threadId, "new")).toEqual({
      shellSelection: { kind: "profile", profileId: "remote-fish" },
    });
  });
});

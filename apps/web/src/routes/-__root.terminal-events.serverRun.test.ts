import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serverConfigFixture } from "../rpc/serverConfig.test.fixture";
import { emitWelcome, resetServerStateForTests, setServerConfigSnapshot } from "../rpc/serverState";
import {
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { terminalPaneOpenOptions } from "../stores/terminal/terminal.store.paneOrigin";
import { resetTerminalServerRunForTests } from "../stores/terminal/terminal.store.serverRun";
import { useTerminalStateStore } from "../stores/terminal/terminal.store";
import { resetTerminalStore, THREAD_ID } from "../stores/terminal/terminal.store.test.helpers";
import { trackTerminalServerRun } from "./-__root.terminal-events";

const welcome = (serverRunId: string) =>
  emitWelcome({ serverRunId, cwd: "/fixture/workspace", projectName: "fixture" });

function withHost(enabled: boolean) {
  setServerConfigSnapshot({
    ...serverConfigFixture,
    workspaceCapabilities: {
      remoteAgent: { enabled: false, supportsDirectoryWatch: false, supportsPtyReattach: false },
      terminalHost: { enabled },
    },
  });
}

let stop: (() => void) | undefined;
beforeEach(() => {
  resetServerStateForTests();
  resetWsConnectionStateForTests();
  resetTerminalServerRunForTests();
  resetTerminalStore();
  useTerminalStateStore.getState().ensureTerminal(THREAD_ID, "pane", { open: true });
});
afterEach(() => stop?.());

describe("server run tracking (plan §14)", () => {
  it("marks every pane restored when the welcome after a reconnect names a new run", () => {
    withHost(true);
    stop = trackTerminalServerRun();
    recordWsConnectionOpened();
    welcome("run-1");
    expect(terminalPaneOpenOptions(THREAD_ID, "pane")).toEqual({});

    // Same run after a reconnect: nothing changes.
    recordWsConnectionClosed();
    recordWsConnectionOpened();
    welcome("run-1");
    expect(terminalPaneOpenOptions(THREAD_ID, "pane")).toEqual({});

    recordWsConnectionClosed();
    recordWsConnectionOpened();
    welcome("run-2");
    expect(terminalPaneOpenOptions(THREAD_ID, "pane")).toEqual({ attachOnly: true });
  });

  it("changes nothing with the terminal host off", () => {
    withHost(false);
    stop = trackTerminalServerRun();
    recordWsConnectionOpened();
    welcome("run-1");
    recordWsConnectionClosed();
    recordWsConnectionOpened();
    welcome("run-2");
    expect(terminalPaneOpenOptions(THREAD_ID, "pane")).toEqual({});
  });
});

import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const coordinator = vi.hoisted(() => ({ openTerminalPanel: vi.fn() }));
vi.mock("../../stores/terminal/terminalPanel.coordinator", () => coordinator);

import { useTerminalStateStore } from "../../stores/terminal";
import {
  createSingleThreadTerminalState,
  newThreadTerminal,
} from "../../stores/terminal/helpers.store";
import { resetTerminalStore } from "../../stores/terminal/terminal.store.test.helpers";
import { useSearchStore } from "../../stores/ui";
import {
  revealTerminalSearchResult,
  terminalSearchLabel,
  toTerminalSearchResults,
} from "./SearchPalette.terminalResults.logic";

const thread = ThreadId.makeUnsafe("thread-1");
const hidden = ThreadId.makeUnsafe("thread-hidden");
const hit = (overrides: Partial<{ threadId: ThreadId; terminalId: string }> = {}) => ({
  threadId: thread,
  terminalId: "term-2",
  lineText: "error: build failed",
  matchStart: 7,
  linesFromEnd: 3,
  running: true,
  ...overrides,
});

describe("terminal search results", () => {
  beforeEach(() => {
    resetTerminalStore();
    useSearchStore.setState({ terminalFindRequest: null });
    coordinator.openTerminalPanel.mockClear();
    useTerminalStateStore.setState({
      terminalStateByThreadId: {
        [thread]: newThreadTerminal(createSingleThreadTerminalState("default"), "term-2"),
      },
      panelTerminalStateByThreadId: { [thread]: createSingleThreadTerminalState("panel-1") },
      terminalLabelOverridesByThreadId: { [thread]: { "panel-1": "Dev server" } },
    });
  });

  it("labels terminals as their tabs do, including renames and panel terminals", () => {
    const store = useTerminalStateStore.getState();
    expect(terminalSearchLabel(store, thread, "default")).toBe("Terminal");
    expect(terminalSearchLabel(store, thread, "term-2")).toBe("Terminal 2");
    expect(terminalSearchLabel(store, thread, "panel-1")).toBe("Dev server");
    expect(terminalSearchLabel(store, thread, "unknown")).toBe("Terminal");
  });

  it("drops hits of threads the palette cannot show", () => {
    const results = toTerminalSearchResults([hit(), hit({ threadId: hidden })], {
      threadTitle: (id) => (id === thread ? "Fix the build" : null),
      store: useTerminalStateStore.getState(),
    });
    expect(results).toEqual([
      expect.objectContaining({
        threadTitle: "Fix the build",
        terminalLabel: "Terminal 2",
        lineText: "error: build failed",
        type: "terminal",
      }),
    ]);
  });

  it("opens a drawer terminal and asks its view to find the hit", () => {
    const [result] = toTerminalSearchResults([hit()], {
      threadTitle: () => "Fix the build",
      store: useTerminalStateStore.getState(),
    });
    useTerminalStateStore.setState((state) => ({
      terminalStateByThreadId: {
        ...state.terminalStateByThreadId,
        [thread]: { ...state.terminalStateByThreadId[thread]!, terminalOpen: false },
      },
    }));
    revealTerminalSearchResult(result!, "failed");
    const drawer = useTerminalStateStore.getState().terminalStateByThreadId[thread]!;
    expect(drawer.terminalOpen).toBe(true);
    expect(drawer.activeTerminalId).toBe("term-2");
    expect(coordinator.openTerminalPanel).not.toHaveBeenCalled();
    expect(useSearchStore.getState().terminalFindRequest).toMatchObject({
      threadId: thread,
      terminalId: "term-2",
      query: "failed",
      lineText: "error: build failed",
    });
  });

  it("opens the side panel for a panel terminal", () => {
    const [result] = toTerminalSearchResults([hit({ terminalId: "panel-1" })], {
      threadTitle: () => "Fix the build",
      store: useTerminalStateStore.getState(),
    });
    revealTerminalSearchResult(result!, "failed");
    expect(coordinator.openTerminalPanel).toHaveBeenCalledOnce();
    expect(
      useTerminalStateStore.getState().panelTerminalStateByThreadId[thread]!.activeTerminalId,
    ).toBe("panel-1");
    expect(
      useTerminalStateStore.getState().terminalStateByThreadId[thread]!.terminalIds,
    ).not.toContain("panel-1");
  });
});

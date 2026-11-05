import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import {
  makeTerminalEvent,
  resetTerminalStore,
  THREAD_ID,
} from "../../stores/terminal/terminal.store.test.helpers";
import { SidebarThreadTerminalProviderIcon } from "./SidebarThreadTerminalProviderIcon";
import type { TerminalStateStoreState } from "../../stores/terminal/terminal.store.types";

// Static markup uses Zustand's initial server snapshot; select the current test store instead.
vi.mock("../../stores/terminal/terminal.store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../stores/terminal/terminal.store")>();
  return {
    ...actual,
    useTerminalStateStore: Object.assign(
      <T,>(selector: (state: TerminalStateStoreState) => T) =>
        selector(actual.useTerminalStateStore.getState()),
      actual.useTerminalStateStore,
    ),
  };
});

const render = () =>
  renderToStaticMarkup(<SidebarThreadTerminalProviderIcon threadId={THREAD_ID} />);

describe("SidebarThreadTerminalProviderIcon", () => {
  beforeEach(resetTerminalStore);

  it("hides without a running terminal agent", () => {
    expect(render()).toBe("");
  });

  it("uses the chat working blue with the breathing animation whenever an agent is open", () => {
    useTerminalStateStore
      .getState()
      .applyTerminalEvent(makeTerminalEvent("agentIdentity", { provider: "pi" }));
    const markup = render();
    expect(markup).toContain("text-info-foreground");
    expect(markup).not.toContain("text-muted-foreground");
    expect(markup).toContain("animate-breathe");
    expect(markup).toContain("motion-reduce:animate-none");
  });

  it("renders the Meta icon for a muse terminal agent in the thread title row", () => {
    useTerminalStateStore
      .getState()
      .applyTerminalEvent(makeTerminalEvent("agentIdentity", { provider: "muse" }));
    const markup = render();
    expect(markup).toContain('aria-label="Terminal provider: Muse Code"');
    expect(markup).toContain('data-slot="thread-terminal-provider-icon"');
    expect(markup).toContain("<svg");
    expect(markup).toContain("text-info-foreground");
  });

  it("labels the terminal provider and follows provider switches and exits", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(makeTerminalEvent("agentIdentity", { provider: "pi" }));
    expect(render()).toContain('aria-label="Terminal provider: Pi"');
    expect(render()).toContain('data-slot="thread-terminal-provider-icon"');
    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        provider: "claudeAgent",
        createdAt: "2026-04-02T20:00:01.000Z",
      }),
    );
    expect(render()).toContain('aria-label="Terminal provider: Claude"');
    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        provider: null,
        createdAt: "2026-04-02T20:00:02.000Z",
      }),
    );
    expect(render()).toBe("");
  });

  it("renders herdr as a terminal-only identity with the same running styling", () => {
    useTerminalStateStore.getState().applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        provider: null,
        agent: { id: "herdr", names: ["herdr"] },
      }),
    );
    const markup = render();
    expect(markup).toContain('aria-label="Terminal: herdr"');
    expect(markup).not.toContain("Terminal provider");
    expect(markup).toContain('viewBox="0 0 408 373"');
    expect(markup).toContain("text-info-foreground");
    expect(markup).toContain("animate-breathe");
  });
});

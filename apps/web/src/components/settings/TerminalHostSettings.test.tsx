import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ saved: false, running: false, environment: false }));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (value: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    selector({ ...DEFAULT_UNIFIED_SETTINGS, terminalHostEnabled: state.saved }),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
vi.mock("../../rpc/serverState", () => ({
  useServerTerminalHostEnabled: () => state.running,
  useServerTerminalHostControlledByEnvironment: () => state.environment,
}));

import {
  TERMINAL_HOST_ENVIRONMENT_NOTE,
  TERMINAL_HOST_RESTART_NOTE,
  TERMINAL_HOST_TITLE,
  TerminalHostSettings,
} from "./TerminalHostSettings";

const render = (platform = "MacIntel") =>
  renderToStaticMarkup(<TerminalHostSettings platform={platform} />);

beforeEach(() => {
  state.saved = false;
  state.running = false;
  state.environment = false;
});

describe("TerminalHostSettings", () => {
  it("is off by default with no restart note", () => {
    expect(DEFAULT_UNIFIED_SETTINGS.terminalHostEnabled).toBe(false);
    const markup = render();
    expect(markup).toContain(TERMINAL_HOST_TITLE);
    expect(markup).toContain('aria-checked="false"');
    expect(markup).not.toContain(TERMINAL_HOST_RESTART_NOTE);
  });

  it("asks for a restart until the saved choice matches the running server", () => {
    state.saved = true;
    expect(render()).toContain(TERMINAL_HOST_RESTART_NOTE);
    state.running = true;
    const markup = render();
    expect(markup).toContain('aria-checked="true"');
    expect(markup).not.toContain(TERMINAL_HOST_RESTART_NOTE);
  });

  it("shows the environment override and disables the toggle", () => {
    state.environment = true;
    state.running = true;
    const markup = render();
    expect(markup).toContain(TERMINAL_HOST_ENVIRONMENT_NOTE);
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("disabled");
  });

  it("is unavailable on Windows", () => {
    state.saved = true;
    const markup = render("Win32");
    expect(markup).toContain("Not available on Windows yet.");
    expect(markup).toContain('aria-checked="false"');
  });
});

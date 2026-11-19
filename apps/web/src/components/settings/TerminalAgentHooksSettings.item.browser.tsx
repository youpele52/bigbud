import "../../index.css";

import type { ProjectEntry } from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { TerminalAgentHookItem } from "./TerminalAgentHooksSettings.item";
import { TERMINAL_AGENT_HOOK_SNIPPETS } from "./TerminalAgentHooksSettings.snippets";

const mocks = vi.hoisted(() => ({
  listings: {} as Record<string, ProjectEntry[]>,
  bound: false,
  openFile: vi.fn(),
  writeFile: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({
    projects: {
      listDirectory: async ({ cwd }: { cwd: string }) => {
        const entries = mocks.listings[cwd];
        if (!entries) throw new Error(`missing ${cwd}`);
        return { entries };
      },
      writeFile: mocks.writeFile,
    },
  }),
}));
vi.mock("../../rpc/serverState", () => ({
  useServerConfig: () => ({
    cwd: "/Users/ada/DevWorld/bigbud",
    keybindingsConfigPath: "/Users/ada/.bigbud/keybindings.json",
    observability: { logsDirectoryPath: "/Users/ada/.bigbud/logs" },
  }),
  useDefaultChatCwd: () => "/Users/ada/Documents",
}));
vi.mock("../../rpc/backendScope.state", () => ({ isBoundBackendWindow: () => mocks.bound }));
vi.mock("../../stores/files/filesPanel.coordinator", () => ({
  openFileInFilesPanel: mocks.openFile,
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: mocks.copy, isCopied: false }),
}));

const HOME: ProjectEntry[] = [{ path: ".claude", kind: "directory" }];
const [claude, codex, , herdr] = TERMINAL_AGENT_HOOK_SNIPPETS;

beforeEach(() => {
  mocks.listings = {
    "~": HOME,
    "/Users/ada": HOME,
    "/Users/ada/.claude": [{ path: "settings.json", kind: "file" }],
  };
  mocks.bound = false;
  mocks.openFile.mockReset();
  mocks.writeFile.mockReset();
  mocks.copy.mockReset();
});

function renderItem(entry: (typeof TERMINAL_AGENT_HOOK_SNIPPETS)[number]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TerminalAgentHookItem entry={entry} />
    </QueryClientProvider>,
  );
}

it("copies without expanding, then expands to highlighted code and opens the existing file", async () => {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
  const screen = await renderItem(claude!);
  try {
    const trigger = page.getByRole("button", { name: /^Claude Code/ });
    await userEvent.click(page.getByRole("button", { name: "Copy Claude Code hook" }));
    expect(mocks.copy).toHaveBeenCalledWith(claude!.snippet);
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => document.querySelector(".chat-markdown-shiki")?.textContent ?? "")
      .toContain("terminalSequence");

    await userEvent.click(
      page.getByRole("button", { name: "Open ~/.claude/settings.json in bigbud" }),
    );
    expect(mocks.openFile).toHaveBeenCalledWith("settings.json", null, "/Users/ada/.claude");
    expect(back).toHaveBeenCalledOnce();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  } finally {
    back.mockRestore();
    await screen.unmount();
  }
});

it("keeps Copy and the path when the config file does not exist, never creating it", async () => {
  const screen = await renderItem(codex!);
  try {
    await userEvent.click(page.getByRole("button", { name: /^Codex CLI/ }));
    await expect
      .element(page.getByText("~/.codex/config.toml does not exist yet", { exact: false }))
      .toBeVisible();
    expect(page.getByRole("button", { name: /^Open / }).elements()).toHaveLength(0);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("offers no open action for a remote backend or a tool without a config file", async () => {
  mocks.bound = true;
  const remote = await renderItem(claude!);
  try {
    await userEvent.click(page.getByRole("button", { name: /^Claude Code/ }));
    await expect
      .element(page.getByText("Hooks run without a terminal", { exact: false }))
      .toBeVisible();
    expect(page.getByRole("button", { name: /^Open / }).elements()).toHaveLength(0);
  } finally {
    await remote.unmount();
  }

  mocks.bound = false;
  const manual = await renderItem(herdr!);
  try {
    await userEvent.click(page.getByRole("button", { name: /^herdr and other tools/ }));
    await expect
      .element(page.getByRole("button", { name: /^herdr and other tools/ }))
      .toHaveAttribute("aria-expanded", "true");
    expect(page.getByRole("button", { name: /^Open / }).elements()).toHaveLength(0);
  } finally {
    await manual.unmount();
  }
});

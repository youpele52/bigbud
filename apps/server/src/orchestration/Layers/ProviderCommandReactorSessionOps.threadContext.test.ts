import { describe, expect, it } from "vitest";

import { prependThreadContextToProviderInput } from "./ProviderCommandReactorSessionOps.threadContext.ts";

describe("prependThreadContextToProviderInput", () => {
  const baseInput = {
    providerInputText: "hello provider",
    threadId: "thread-abc",
    threadTitle: "Computer use thread",
  };

  it("tells desktop agents to use computer_use for native automation and browser for bigbud", () => {
    const result = prependThreadContextToProviderInput({
      ...baseInput,
      computerUseEnabled: true,
      serverMode: "desktop",
    });

    expect(result).toContain("Current thread context:");
    expect(result).toContain("Thread ID: thread-abc");
    expect(result).toContain("When the `update_plan` tool is available");
    expect(result).toContain("Do not wait until the end of the turn.");
    expect(result).toContain("whose name ends with `rename_thread`");
    expect(result).toContain("list pinned threads globally across all projects");
    expect(result).toContain("Only use this when the user explicitly asks to pin a thread.");
    expect(result).toContain("Only use this when the user explicitly asks to unpin a thread.");
    expect(result).toContain("call the `create_thread` tool");
    expect(result).toContain("a self-contained task that includes all necessary context");
    expect(result).toContain("Omit `projectId` to target the current project");
    expect(result).toContain("only provide an explicitly authorized `projectId`");
    expect(result).toContain(
      "use it only for an authorized workspace once workspace-path policy support lands",
    );
    expect(result).toContain("the current implementation rejects it, so do not send it now");
    expect(result).toContain(
      "An accepted `create_thread` request means the request was accepted, not that the child agent has started",
    );
    expect(result).toContain(
      "Use `get_thread_status` with the returned thread ID to poll startup and workflow progress",
    );
    expect(result).toContain(
      "retry `create_thread` only when the request was rejected or no acceptance was received",
    );
    expect(result).toContain('call the `computer_use` tool with `surface: "desktop"`');
    expect(result).toContain("Use the `browser` tool for bigbud's built-in visible or background");
    expect(result).toContain(
      "Use `check_permissions` or `doctor` first if desktop automation fails.",
    );
    expect(result).toContain("hello provider");
  });

  it("tells web runtime agents that desktop automation requires the desktop app", () => {
    const result = prependThreadContextToProviderInput({
      ...baseInput,
      computerUseEnabled: true,
      serverMode: "web",
    });

    expect(result).toContain("Desktop automation requires the Bigbud desktop app.");
    expect(result).not.toContain("Use `check_permissions` or `doctor` first");
  });

  it("communicates limited capability when desktop computer use is disabled", () => {
    const result = prependThreadContextToProviderInput({
      ...baseInput,
      computerUseEnabled: false,
      serverMode: "desktop",
    });

    expect(result).toContain("Desktop computer use is disabled in Bigbud settings");
    expect(result).toContain(
      "Use the `browser` tool for bigbud's built-in visible or background browser",
    );
    expect(result).not.toContain("Use `check_permissions` or `doctor` first");
  });

  it("carries the system browser preference through fallback context", () => {
    const result = prependThreadContextToProviderInput({
      ...baseInput,
      computerUseEnabled: true,
      serverMode: "desktop",
      agentBrowserPreference: "system",
    });

    expect(result).toContain("default agent browser is the system default browser");
    expect(result).toContain("an explicit user request for the other browser always overrides it");
    expect(result).toContain('`action: "navigate"` and `surface: "desktop"`');
  });
});

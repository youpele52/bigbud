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
    expect(result).not.toContain("workspacePath");
    expect(result).toContain(
      "An accepted `create_thread` request means the request was accepted, not that the child agent has started",
    );
    expect(result).toContain(
      "Use `get_thread_status` with the returned thread ID to poll startup and workflow progress",
    );
    expect(result).toContain("It works for any thread in any project, with no confirmation.");
    expect(result).not.toContain("not arbitrary cross-project threads");
    expect(result).toContain('may return `status: "confirmation_required"`');
    expect(result).toContain(
      "ask the user about one project at a time, showing the exact `question` text, which names the project",
    );
    expect(result).toContain("use your question tool with the options `Allow` and `Deny`");
    expect(result).toContain("retry the one you ask about first");
    expect(result).toContain(
      "do not retry it or ask about it again unless the user brings it up. A different, later request may ask again.",
    );
    expect(result).toContain("ask the user in chat to reply yes or no");
    expect(result).toContain("Never ask the user to type a code");
    expect(result).toContain("ask them to reply yes or no in chat, then retry");
    expect(result).toContain("Never answer on the user's behalf.");
    expect(result).not.toContain("allow <code>");
    expect(result).not.toContain("type the code in chat");
    expect(result).toContain(
      "When the user's own latest message attached the thread you are changing (for `create_thread`, a thread in that project), just do it; bigbud asks only otherwise.",
    );
    expect(result).toContain(
      "Reading a thread grants nothing, and a request the user attached covers only that request.",
    );
    expect(result).toContain("supersedes older tool descriptions");
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

  it("explains delegated model choice only where the bridge offers it", () => {
    const supported = prependThreadContextToProviderInput({
      ...baseInput,
      supportsDelegatedModelChoice: true,
    });
    expect(supported).toContain("call `list_available_models`");
    expect(supported).toContain("pass one as `modelSelection` to `create_thread`");
    expect(supported).toContain("never fails or waits because of `modelSelection`");
    expect(supported).toContain("`list_available_models`, `send_thread_message`");

    const unsupported = prependThreadContextToProviderInput({
      ...baseInput,
      supportsDelegatedModelChoice: false,
    });
    expect(unsupported).not.toContain("list_available_models");
    expect(unsupported).not.toContain("modelSelection");
  });

  it("tells web runtime agents that desktop automation requires the desktop app", () => {
    const result = prependThreadContextToProviderInput({
      ...baseInput,
      computerUseEnabled: true,
      serverMode: "web",
    });

    expect(result).toContain("Desktop automation requires the bigbud desktop app.");
    expect(result).not.toContain("Use `check_permissions` or `doctor` first");
  });

  it("communicates limited capability when desktop computer use is disabled", () => {
    const result = prependThreadContextToProviderInput({
      ...baseInput,
      computerUseEnabled: false,
      serverMode: "desktop",
    });

    expect(result).toContain("Desktop computer use is disabled in bigbud settings");
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

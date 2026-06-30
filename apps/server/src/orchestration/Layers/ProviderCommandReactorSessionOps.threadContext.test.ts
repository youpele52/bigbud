import { describe, expect, it } from "vitest";

import { prependThreadContextToProviderInput } from "./ProviderCommandReactorSessionOps.threadContext.ts";

describe("prependThreadContextToProviderInput", () => {
  const baseInput = {
    providerInputText: "hello provider",
    threadId: "thread-abc",
    threadTitle: "Computer use thread",
  };

  it("tells desktop agents to use computer_use for native and browser automation", () => {
    const result = prependThreadContextToProviderInput({
      ...baseInput,
      computerUseEnabled: true,
      serverMode: "desktop",
    });

    expect(result).toContain("Current thread context:");
    expect(result).toContain("Thread ID: thread-abc");
    expect(result).toContain('call the `computer_use` tool with `surface: "desktop"`');
    expect(result).toContain('call `computer_use` with `surface: "browser"`');
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
      'Browser automation via `computer_use` with `surface: "browser"` may still work',
    );
    expect(result).not.toContain("Use `check_permissions` or `doctor` first");
  });
});

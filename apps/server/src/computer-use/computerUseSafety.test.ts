import { describe, expect, it } from "vitest";

import { guardComputerUseAction, guardComputerUseTarget } from "./computerUseSafety";

describe("guardComputerUseAction", () => {
  it("blocks force-quit key combos", () => {
    expect(guardComputerUseAction({ action: "key", key: "cmd+q" })).not.toBeNull();
    expect(guardComputerUseAction({ action: "key", key: "Cmd+Q" })).not.toBeNull();
    expect(guardComputerUseAction({ action: "key", key: "meta+q" })).not.toBeNull();
  });

  it("blocks Alt+F4", () => {
    expect(guardComputerUseAction({ action: "key", key: "alt+f4" })).not.toBeNull();
  });

  it("blocks Ctrl+Alt+Del", () => {
    expect(guardComputerUseAction({ action: "key", key: "ctrl+alt+del" })).not.toBeNull();
  });

  it("blocks task manager shortcut", () => {
    expect(guardComputerUseAction({ action: "key", key: "ctrl+shift+esc" })).not.toBeNull();
  });

  it("allows safe key combos", () => {
    expect(guardComputerUseAction({ action: "key", key: "enter" })).toBeNull();
    expect(guardComputerUseAction({ action: "key", key: "cmd+c" })).toBeNull();
    expect(guardComputerUseAction({ action: "key", key: "ctrl+a" })).toBeNull();
  });

  it("blocks typing password-like text", () => {
    expect(
      guardComputerUseAction({ action: "type", text: "my password is hunter2" }),
    ).not.toBeNull();
    expect(
      guardComputerUseAction({ action: "type", text: "api_key=sk-1234567890" }),
    ).not.toBeNull();
  });

  it("blocks typing credit-card-like numbers", () => {
    expect(guardComputerUseAction({ action: "type", text: "4111 1111 1111 1111" })).not.toBeNull();
    expect(guardComputerUseAction({ action: "type", text: "4111-1111-1111-1111" })).not.toBeNull();
  });

  it("blocks typing SSN-like numbers", () => {
    expect(guardComputerUseAction({ action: "type", text: "123-45-6789" })).not.toBeNull();
  });

  it("allows safe text", () => {
    expect(guardComputerUseAction({ action: "type", text: "Hello world" })).toBeNull();
    expect(guardComputerUseAction({ action: "type", text: "click the button" })).toBeNull();
  });

  it("blocks sensitive app launch requests", () => {
    expect(guardComputerUseAction({ action: "launch_app", name: "Terminal" })).not.toBeNull();
    expect(guardComputerUseAction({ action: "focus_app", name: "1Password" })).not.toBeNull();
  });

  it("blocks navigation to sensitive payment or banking pages", () => {
    expect(
      guardComputerUseAction({ action: "navigate", url: "https://example.com/checkout" }),
    ).not.toBeNull();
  });

  it("does not block non-key/non-type actions", () => {
    expect(guardComputerUseAction({ action: "capture" })).toBeNull();
    expect(guardComputerUseAction({ action: "click", x: 1, y: 2 })).toBeNull();
    expect(guardComputerUseAction({ action: "scroll", deltaY: 10 })).toBeNull();
  });
});

describe("guardComputerUseTarget", () => {
  it("blocks mutating desktop actions in sensitive apps", () => {
    expect(
      guardComputerUseTarget({
        action: { action: "click", x: 1, y: 2 },
        surface: "desktop",
        appName: "System Settings",
      }),
    ).not.toBeNull();
  });

  it("allows read-only captures for sensitive desktop apps", () => {
    expect(
      guardComputerUseTarget({
        action: { action: "capture", surface: "desktop" },
        surface: "desktop",
        appName: "System Settings",
      }),
    ).toBeNull();
  });

  it("blocks mutating browser actions on sensitive pages", () => {
    expect(
      guardComputerUseTarget({
        action: { action: "type", text: "hello" },
        surface: "browser",
        url: "https://bank.example.com",
      }),
    ).not.toBeNull();
  });
});

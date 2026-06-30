import { describe, expect, it } from "vitest";

import { guardComputerUseAction } from "./computerUseSafety";

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

  it("does not block non-key/non-type actions", () => {
    expect(guardComputerUseAction({ action: "capture" })).toBeNull();
    expect(guardComputerUseAction({ action: "click", x: 1, y: 2 })).toBeNull();
    expect(guardComputerUseAction({ action: "scroll", deltaY: 10 })).toBeNull();
  });
});

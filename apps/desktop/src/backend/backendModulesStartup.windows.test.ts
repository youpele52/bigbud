import { describe, expect, it, vi } from "vitest";

import { ensureWindowsBackendModulesPath } from "./backendModulesStartup.windows";

describe("ensureWindowsBackendModulesPath", () => {
  it("uses a junction when available", () => {
    const fileSystem = {
      symlinkSync: vi.fn(),
      cpSync: vi.fn(),
    };

    ensureWindowsBackendModulesPath(
      "C:\\resources\\server\\_modules",
      "C:\\server\\node_modules",
      fileSystem,
    );

    expect(fileSystem.symlinkSync).toHaveBeenCalledWith(
      "C:\\resources\\server\\_modules",
      "C:\\server\\node_modules",
      "junction",
    );
    expect(fileSystem.cpSync).not.toHaveBeenCalled();
  });

  it("falls back to copying when junction creation fails", () => {
    const fileSystem = {
      symlinkSync: vi.fn(() => {
        throw new Error("junction unavailable");
      }),
      cpSync: vi.fn(),
    };

    ensureWindowsBackendModulesPath(
      "C:\\resources\\server\\_modules",
      "C:\\server\\node_modules",
      fileSystem,
    );

    expect(fileSystem.cpSync).toHaveBeenCalledWith(
      "C:\\resources\\server\\_modules",
      "C:\\server\\node_modules",
      { recursive: true },
    );
  });
});

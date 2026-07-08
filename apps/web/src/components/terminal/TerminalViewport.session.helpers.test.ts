import { describe, expect, it, vi } from "vitest";

import {
  acceptsTerminalDrop,
  formatDroppedTerminalPath,
  pasteDroppedTerminalPaths,
  readDroppedTerminalPaths,
} from "./TerminalViewport.drop";

describe("terminal drop helpers", () => {
  it("accepts internal file-panel drags and native file drags", () => {
    expect(acceptsTerminalDrop(["application/x-bigbud-files-panel-entry"])).toBe(true);
    expect(acceptsTerminalDrop(["Files"])).toBe(true);
    expect(acceptsTerminalDrop(["text/plain"])).toBe(false);
  });

  it("reads an internal files panel drag path before native files", () => {
    expect(
      readDroppedTerminalPaths({
        dataTransfer: {
          types: ["application/x-bigbud-files-panel-entry"],
          files: [] as unknown as FileList,
          getData: () =>
            JSON.stringify({
              name: "README.md",
              path: "/Users/youpele/DevWorld/bigbud/README.md",
              entryKind: "file",
            }),
        },
        readNativeFilePath: () => "",
      }),
    ).toEqual([{ path: "/Users/youpele/DevWorld/bigbud/README.md", origin: "internal" }]);
  });

  it("reads native file paths when available", () => {
    const files = [{ name: "a.ts" }, { name: "b.ts" }] as unknown as FileList;

    expect(
      readDroppedTerminalPaths({
        dataTransfer: {
          types: ["Files"],
          files,
          getData: () => "",
        },
        readNativeFilePath: (file) => `/tmp/${file.name}`,
      }),
    ).toEqual([
      { path: "/tmp/a.ts", origin: "native" },
      { path: "/tmp/b.ts", origin: "native" },
    ]);
  });

  it("focuses and pastes the dropped paths into the terminal input path", () => {
    const focus = vi.fn();
    const paste = vi.fn();

    expect(
      pasteDroppedTerminalPaths({
        terminal: { focus, paste },
        paths: ["/tmp/a.ts", "/tmp/b.ts"],
        dropPathMode: "posix",
      }),
    ).toBe(true);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith("'/tmp/a.ts' '/tmp/b.ts'");
  });

  it("quotes dropped paths for POSIX shells when they contain spaces or apostrophes", () => {
    expect(formatDroppedTerminalPath("/Users/youpele/Documents/Obsidian Vault", "posix")).toBe(
      "'/Users/youpele/Documents/Obsidian Vault'",
    );
    expect(formatDroppedTerminalPath("/tmp/it's here", "posix")).toBe("'/tmp/it'\\''s here'");
  });

  it("quotes dropped paths for Windows cmd shells", () => {
    expect(formatDroppedTerminalPath("C:\\Users\\youpele\\Obsidian Vault", "cmd")).toBe(
      '"C:\\Users\\youpele\\Obsidian Vault"',
    );
  });

  it("quotes dropped paths for PowerShell shells", () => {
    expect(formatDroppedTerminalPath("C:\\Users\\youpele\\it's here", "powershell")).toBe(
      "'C:\\Users\\youpele\\it''s here'",
    );
  });

  it("converts Windows paths for MSYS-compatible shells", () => {
    expect(formatDroppedTerminalPath("C:\\Users\\youpele\\Obsidian Vault", "msys")).toBe(
      "'/c/Users/youpele/Obsidian Vault'",
    );
  });

  it("converts Windows paths for WSL shells", () => {
    expect(formatDroppedTerminalPath("C:\\Users\\youpele\\Obsidian Vault", "wsl")).toBe(
      "'/mnt/c/Users/youpele/Obsidian Vault'",
    );
  });
});

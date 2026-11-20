import { describe, expect, it } from "vitest";

import { acceptsTerminalDrop, readDroppedTerminalPaths } from "./TerminalViewport.drop";
import { formatTerminalPath, formatTerminalPathPastes } from "./TerminalViewport.paths";

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
      { path: "/tmp/a.ts", origin: "native", file: files[0] },
      { path: "/tmp/b.ts", origin: "native", file: files[1] },
    ]);
  });

  it("pastes several paths as one bracketed paste each, separated by a space", () => {
    expect(formatTerminalPathPastes(["/tmp/a.ts", "/tmp/b c.ts"], "posix", true)).toBe(
      "\x1b[200~/tmp/a.ts\x1b[201~ \x1b[200~/tmp/b\\ c.ts\x1b[201~",
    );
    expect(formatTerminalPathPastes(["/tmp/a.ts", "/tmp/b.ts"], "posix", false)).toBe(
      "/tmp/a.ts /tmp/b.ts",
    );
  });

  it("escapes POSIX paths so every TUI and shell reads one absolute path", () => {
    expect(formatTerminalPath("/Users/youpele/Documents/Obsidian Vault", "posix")).toBe(
      "/Users/youpele/Documents/Obsidian\\ Vault",
    );
    expect(formatTerminalPath("/tmp/it's here", "posix")).toBe("/tmp/it\\'s\\ here");
    expect(formatTerminalPath('/tmp/a$b`c"d!(e)~&;|*?#<>[]{}^', "posix")).toBe(
      '/tmp/a\\$b\\`c\\"d\\!\\(e\\)\\~\\&\\;\\|\\*\\?\\#\\<\\>\\[\\]\\{\\}\\^',
    );
    expect(formatTerminalPath("/tmp/café_1.0-x+y@z:%=,.png", "posix")).toBe(
      "/tmp/café_1.0-x+y@z:%=,.png",
    );
    expect(formatTerminalPath("/tmp/line\nbreak", "posix")).toBe("'/tmp/line\nbreak'");
  });

  it("quotes dropped paths for Windows cmd shells", () => {
    expect(formatTerminalPath("C:\\Users\\youpele\\Obsidian Vault", "cmd")).toBe(
      '"C:\\Users\\youpele\\Obsidian Vault"',
    );
  });

  it("quotes dropped paths for PowerShell shells", () => {
    expect(formatTerminalPath("C:\\Users\\youpele\\it's here", "powershell")).toBe(
      "'C:\\Users\\youpele\\it''s here'",
    );
  });

  it("converts Windows paths for MSYS-compatible shells", () => {
    expect(formatTerminalPath("C:\\Users\\youpele\\Obsidian Vault", "msys")).toBe(
      "'/c/Users/youpele/Obsidian Vault'",
    );
  });

  it("converts Windows paths for WSL shells", () => {
    expect(formatTerminalPath("C:\\Users\\youpele\\Obsidian Vault", "wsl")).toBe(
      "'/mnt/c/Users/youpele/Obsidian Vault'",
    );
  });
});

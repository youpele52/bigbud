import type { NativeApi } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";
import { openTerminalPath } from "./TerminalViewport.links.open";
import { formatDroppedTerminalPath, rejectWslTerminalFileDrop } from "./TerminalViewport.drop";

describe("explicit WSL file boundaries", () => {
  it("rejects file links before any filesystem, shell or panel API", async () => {
    const api = {
      projects: { listDirectory: vi.fn() },
      shell: { openInEditor: vi.fn(), openPath: vi.fn() },
    };
    await expect(
      openTerminalPath({
        api: api as unknown as NativeApi,
        rawPath: "src/a.ts",
        cwd: "/project",
        workspaceRoot: "/project",
        executionTargetId: "wsl:Ubuntu",
      }),
    ).rejects.toThrow("File links are unavailable");
    expect(api.projects.listDirectory).not.toHaveBeenCalled();
    expect(api.shell.openPath).not.toHaveBeenCalled();
    expect(api.shell.openInEditor).not.toHaveBeenCalled();
  });
  it("rejects both host and internal drops with a clear notice", () => {
    const notice = vi.fn();
    expect(rejectWslTerminalFileDrop("wsl:Ubuntu", notice)).toBe(true);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("File drops are unavailable"));
    expect(rejectWslTerminalFileDrop("local", notice)).toBe(false);
    expect(rejectWslTerminalFileDrop("ssh:host=box", notice)).toBe(false);
    expect(notice).toHaveBeenCalledTimes(1);
  });
  it("legacy shell-only WSL drop formatting stays unchanged", () => {
    expect(formatDroppedTerminalPath("C:\\dev\\a", "wsl")).toBe("'/mnt/c/dev/a'");
    expect(formatDroppedTerminalPath("C:\\dev\\a", "cmd")).toBe('"C:\\dev\\a"');
  });
});

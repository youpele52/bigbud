import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const handlers = vi.hoisted(() => new Map<string, Listener>());
const shell = vi.hoisted(() => ({
  openPath: vi.fn(async (_path: string) => ""),
  showItemInFolder: vi.fn((_path: string) => undefined),
}));
vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
  },
  shell,
}));

import { desktopIpcChannels } from "../main.channels";
import {
  authorizeFakeSenders,
  fakeIpcSender,
  mainFrameEvent,
} from "./ipcAuthorization.testSupport";
import { registerShellPathIpc } from "./shellPathHandlers";

const main = fakeIpcSender(1);
const compact = fakeIpcSender(2);
let dir: string;

function write(name: string, contents: string | Uint8Array, mode = 0o644): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, contents);
  fs.chmodSync(target, mode);
  return target;
}

function invoke(channel: string, rawPath: unknown, sender = main) {
  return handlers.get(channel)!(mainFrameEvent(sender), rawPath);
}

const openPath = (rawPath: unknown) => invoke(desktopIpcChannels.openPath, rawPath);
const reveal = (rawPath: unknown) => invoke(desktopIpcChannels.showItemInFolder, rawPath);

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  shell.openPath.mockResolvedValue("");
  authorizeFakeSenders([
    [main, "main"],
    [compact, "compact-chat"],
  ]);
  registerShellPathIpc();
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-shell-path-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("desktop:open-path", () => {
  it("opens a plain document through Electron with its real path", async () => {
    const target = write("report.docx", "PK");
    await expect(openPath(target)).resolves.toEqual({ status: "opened" });
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(target);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("refuses relative, non-string, NUL and missing paths without touching the OS", async () => {
    for (const raw of ["report.docx", "./a.txt", "~/a.txt", 7, null, `${dir}/a\0.txt`]) {
      await expect(openPath(raw), String(raw)).resolves.toEqual({
        status: "refused",
        reason: "invalid-path",
      });
    }
    await expect(openPath(path.join(dir, "missing.pdf"))).resolves.toEqual({
      status: "refused",
      reason: "not-found",
    });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "reveals executables and scripts instead of launching them",
    async () => {
      const bundle = path.join(dir, "Installer.app");
      fs.mkdirSync(bundle);
      const launchables = [
        write("setup.exe", "MZ"),
        write("deploy.sh", "echo hi"),
        write("Run.COMMAND", "echo hi"),
        write("installer.pkg", "xar!"),
        write("no-extension", "data", 0o755),
        write("elf.bin", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2])),
        write("script.txt", "#!/bin/sh\nrm -rf ~"),
        bundle,
      ];
      for (const target of launchables) {
        await expect(openPath(target), target).resolves.toEqual({
          status: "revealed",
          launchable: true,
        });
        expect(shell.showItemInFolder).toHaveBeenLastCalledWith(target);
      }
      expect(shell.openPath).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "reveals a symlink with an innocent name that points at a script",
    async () => {
      const script = write("payload.sh", "echo hi");
      const link = path.join(dir, "notes.txt");
      fs.symlinkSync(script, link);
      await expect(openPath(link)).resolves.toEqual({ status: "revealed", launchable: true });
      expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(script);
      expect(shell.openPath).not.toHaveBeenCalled();
    },
  );

  it("reports the OS error when no default app can open the file", async () => {
    shell.openPath.mockResolvedValueOnce("No application knows how to open this file.");
    await expect(openPath(write("data.xyz", "?"))).resolves.toEqual({
      status: "refused",
      reason: "open-failed",
      message: "No application knows how to open this file.",
    });
  });

  it("denies windows other than the main window with a bounded null", async () => {
    const target = write("report.docx", "PK");
    expect(await invoke(desktopIpcChannels.openPath, target, compact)).toBeNull();
    expect(await invoke(desktopIpcChannels.showItemInFolder, target, compact)).toBeNull();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe("desktop:show-item-in-folder", () => {
  it("reveals files, folders and executables but never opens them", async () => {
    const doc = write("a.pdf", "%PDF");
    const script = write("b.sh", "echo hi");
    await expect(reveal(doc)).resolves.toEqual({ status: "revealed", launchable: false });
    await expect(reveal(script)).resolves.toEqual({ status: "revealed", launchable: true });
    await expect(reveal(dir)).resolves.toEqual({ status: "revealed", launchable: false });
    expect(shell.showItemInFolder.mock.calls).toEqual([[doc], [script], [dir]]);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("refuses relative and missing paths", async () => {
    await expect(reveal("a.pdf")).resolves.toEqual({ status: "refused", reason: "invalid-path" });
    await expect(reveal(path.join(dir, "gone"))).resolves.toEqual({
      status: "refused",
      reason: "not-found",
    });
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});

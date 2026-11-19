import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import type { TerminalPasteStageInput } from "@bigbud/contracts/workspace/terminal.paste.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindTerminalLaunch, forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { DEFAULT_BINDINGS } from "../../models/keybindings/keybindings.models.test.helpers";
import { toastManager } from "../ui/toast.manager";
import { attachTerminalViewportInput } from "./TerminalViewport.input";
import { terminalFileDelivery } from "./TerminalViewport.paste";

const THREAD = "paste-browser";
let terminalCount = 0;

function fixture(options: { target?: string; stagedPath?: string } = {}) {
  const terminalId = `paste-${++terminalCount}`;
  bindTerminalLaunch(THREAD, terminalId, {
    cwd: "/",
    executionTargetId: options.target ?? "local",
    runtimeGeneration: "gen-1",
  });
  const container = document.createElement("div");
  container.style.cssText = "width:640px;height:320px";
  document.body.append(container);
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  terminal.open(container);
  terminal.focus();
  const write = vi.fn(async (_request: { data: string }) => {});
  const staged: TerminalPasteStageInput[] = [];
  const stagePasteFile = vi.fn(async (input: TerminalPasteStageInput) => {
    staged.push(input);
    if (input.op === "begin")
      return {
        op: "begin",
        uploadId: "0123456789abcdef",
        chunkBytes: 4,
        host: options.target === "local" || !options.target ? "local" : "remote",
        hostLabel: "vps.example",
      };
    if (input.op === "chunk") return { op: "chunk", receivedBytes: input.offset + 4 };
    return {
      op: "commit",
      path:
        options.stagedPath ??
        "/Users/me/Library/Application Support/bigbud/terminal-paste/paste-ab.png",
      host: "local",
      hostLabel: "this computer",
      clipboard: "skipped",
    };
  });
  const attached = attachTerminalViewportInput({
    terminal,
    terminalRef: { current: terminal },
    threadId: THREAD,
    terminalId,
    keybindingsRef: { current: DEFAULT_BINDINGS },
    api: { terminal: { write, stagePasteFile } } as unknown as NativeApi,
    acceptsInput: () => true,
    markInput: vi.fn(),
    writeNotice: vi.fn(),
    tuiWheelMultiplier: () => 1,
    onFind: vi.fn(),
    dropPathModeRef: { current: "posix" },
  });
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const written = () => write.mock.calls.map(([request]) => request.data).join("");
  const paste = (data: DataTransfer) => {
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    return event;
  };
  const output = (data: string) =>
    new Promise<void>((resolve) => terminal.write(data, () => resolve()));
  const enableBracketedPaste = () => output("\x1b[?2004h");
  return {
    terminal,
    textarea,
    write,
    written,
    staged,
    paste,
    enableBracketedPaste,
    output,
    dispose() {
      attached.dispose();
      terminal.dispose();
      container.remove();
      forgetTerminalLaunch(THREAD, terminalId);
    },
  };
}

function imageTransfer(text = "") {
  const data = new DataTransfer();
  data.items.add(
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])], "image.png", { type: "image/png" }),
  );
  if (text) data.setData("text/plain", text);
  return data;
}

afterEach(() => {
  Reflect.deleteProperty(window, "desktopBridge");
});

describe("terminal paste of images and files", () => {
  it("stages a pasted image and pastes its absolute path as one bracketed paste", async () => {
    const f = fixture();
    try {
      await f.enableBracketedPaste();
      const event = f.paste(imageTransfer());
      expect(event.defaultPrevented).toBe(true);
      await expect
        .poll(f.written)
        .toBe(
          "\x1b[200~/Users/me/Library/Application\\ Support/bigbud/terminal-paste/paste-ab.png\x1b[201~",
        );
      expect(f.staged.map((input) => input.op)).toEqual(["begin", "chunk", "chunk", "commit"]);
      // The client never names a machine; the server derives it from the session.
      expect(f.staged[0]).not.toHaveProperty("executionTargetId");
      expect(f.staged[0]).toMatchObject({ threadId: THREAD, expectedGeneration: "gen-1" });
    } finally {
      f.dispose();
    }
  });

  it("leaves text pastes to xterm, text winning over an image", async () => {
    const f = fixture();
    try {
      await f.enableBracketedPaste();
      f.paste(imageTransfer("hello"));
      await expect.poll(f.written).toBe("\x1b[200~hello\x1b[201~");
      expect(f.staged).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  it("refuses a file over the paste limit with binary-unit sizes, before uploading", async () => {
    const add = vi.spyOn(toastManager, "add");
    const f = fixture();
    try {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(21 * 1024 * 1024)], "big.png", { type: "image/png" }),
      );
      f.paste(data);
      await expect.poll(() => add.mock.calls.length).toBe(1);
      expect(add.mock.calls[0]?.[0]).toMatchObject({
        type: "error",
        description:
          "It is 21.00 MiB; the paste limit is 20.00 MiB. Change it in Settings › Terminal.",
      });
      expect(f.staged).toEqual([]);
    } finally {
      add.mockRestore();
      f.dispose();
    }
  });

  it("pastes the real absolute path of a Finder-copied file without uploading", async () => {
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { getFilePath: () => "/Users/me/Desktop/Screen Shot 1.png" },
    });
    const f = fixture();
    try {
      f.paste(imageTransfer("image.png"));
      await expect.poll(f.written).toBe("/Users/me/Desktop/Screen\\ Shot\\ 1.png");
      expect(f.staged).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  it("uploads Finder files to a remote terminal and pastes the remote absolute path", async () => {
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { getFilePath: () => "/Users/me/Desktop/a.png" },
    });
    const f = fixture({
      target: "ssh:host=vps.example",
      stagedPath: "/home/dev/.bigbud/agent/paste/0123/paste-ab.png",
    });
    try {
      f.paste(imageTransfer());
      await expect.poll(f.written).toBe("/home/dev/.bigbud/agent/paste/0123/paste-ab.png");
      expect(f.staged[0]?.op).toBe("begin");
    } finally {
      f.dispose();
    }
  });

  it("routes a remote native drop through the same upload", async () => {
    const f = fixture({
      target: "ssh:host=vps.example",
      stagedPath: "/home/dev/.bigbud/agent/paste/0123/paste-cd.pdf",
    });
    try {
      const file = new File(["%PDF"], "My report.pdf", { type: "application/pdf" });
      terminalFileDelivery(f.terminal)?.deliver({
        kind: "deliver",
        items: [{ kind: "stage", file }],
      });
      await expect.poll(f.written).toBe("/home/dev/.bigbud/agent/paste/0123/paste-cd.pdf");
    } finally {
      f.dispose();
    }
  });

  it("keeps Ctrl+V as the TUI's key (0x16)", async () => {
    const f = fixture();
    try {
      f.textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "v",
          code: "KeyV",
          keyCode: 86,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await expect.poll(f.written).toBe("\x16");
      expect(f.staged).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  it("answers OSC 5522 reads only after a paste in this pane (kitty clipboard protocol)", async () => {
    const f = fixture();
    try {
      const request = `\x1b]5522;type=read;${btoa("text/plain")}\x1b\\`;
      await f.output(request);
      await expect.poll(f.written).toBe("\x1b]5522;type=read:status=EPERM\x1b\\");
      f.write.mockClear();
      const text = new DataTransfer();
      text.setData("text/plain", "hello");
      f.paste(text);
      await expect.poll(f.written).toBe("hello");
      f.write.mockClear();
      await f.output(request);
      await expect
        .poll(f.written)
        .toContain(`status=DATA:mime=${btoa("text/plain")};${btoa("hello")}`);
    } finally {
      f.dispose();
    }
  });

  it("sends a paste event instead of bracketed text when the program enabled mode 5522", async () => {
    const f = fixture();
    try {
      await f.enableBracketedPaste();
      await f.output("\x1b[?5522h\x1b[?5522$p");
      await expect.poll(f.written).toBe("\x1b[?5522;1$y");
      f.write.mockClear();
      f.paste(imageTransfer());
      await expect.poll(f.written).toContain("type=read:status=OK:pw=");
      expect(f.written()).not.toContain("\x1b[200~");
      expect(f.staged).toEqual([]);
    } finally {
      f.dispose();
    }
  });
});

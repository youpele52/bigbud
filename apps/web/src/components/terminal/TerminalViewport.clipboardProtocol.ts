import type { IDisposable, Terminal } from "@xterm/xterm";
import { TERMINAL_PASTE_MAX_FILE_MB } from "@bigbud/contracts/core/settings.terminalPaste.ts";
import { getServerConfig } from "../../rpc/serverState";
import {
  ClipboardProtocolState,
  type ClipboardSnapshotItem,
} from "./TerminalViewport.clipboardProtocol.logic";
import type { TerminalPasteGesture } from "./TerminalViewport.paste";

const PASTE_EVENT_MODE = 5522;
const textEncoder = new TextEncoder();

function hasMode(params: ReadonlyArray<number | number[]>): boolean {
  return params.some((param) => (Array.isArray(param) ? param[0] : param) === PASTE_EVENT_MODE);
}

function randomPassword(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Text first, then each distinct file type, as the clipboard snapshot of one paste gesture. */
export function clipboardSnapshotItems(gesture: TerminalPasteGesture): ClipboardSnapshotItem[] {
  const items: ClipboardSnapshotItem[] = [];
  if (gesture.text.length > 0) {
    const bytes = textEncoder.encode(gesture.text);
    items.push({ mime: "text/plain", size: bytes.length, read: async () => bytes });
  }
  for (const file of gesture.files) {
    const mime = file.type || "application/octet-stream";
    if (items.some((item) => item.mime === mime)) continue;
    items.push({
      mime,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    });
  }
  return items;
}

/**
 * Registers OSC 5522 and its DECSET/DECRQM mode on one pane. Replies go to that pane's PTY only.
 */
export function attachTerminalClipboardProtocol(options: {
  readonly terminal: Terminal;
  readonly reply: (data: string) => void;
}) {
  const settings = () => getServerConfig()?.settings;
  const state = new ClipboardProtocolState({
    now: Date.now,
    randomPassword,
    enabled: () => settings()?.terminalClipboardRequests ?? true,
    maxBytes: () =>
      (settings()?.terminalPasteMaxFileMb ?? TERMINAL_PASTE_MAX_FILE_MB.default) * 1024 * 1024,
  });
  const { parser } = options.terminal;
  const disposables: IDisposable[] = [
    parser.registerOscHandler(PASTE_EVENT_MODE, (data) => {
      void state.handle(data).then(
        (reply) => {
          if (reply) options.reply(reply);
        },
        () => options.reply("\x1b]5522;type=read:status=EPERM\x1b\\"),
      );
      return true;
    }),
    // Mode changes fall through (return false) so xterm still applies the other modes.
    parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (hasMode(params)) state.pasteEventMode = true;
      return false;
    }),
    parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (hasMode(params)) state.pasteEventMode = false;
      return false;
    }),
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) => {
      if (!hasMode(params)) return false;
      options.reply(state.modeReport());
      return true;
    }),
  ];
  return {
    /** Records the gesture; true when it was delivered as a paste event instead of a paste. */
    onPasteGesture: (gesture: TerminalPasteGesture): boolean => {
      const announcement = state.onPasteGesture(clipboardSnapshotItems(gesture));
      if (announcement === null) return false;
      options.reply(announcement);
      return true;
    },
    /** A replaced shell starts without the previous program's mode or paste snapshot. */
    reset: () => state.reset(),
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}

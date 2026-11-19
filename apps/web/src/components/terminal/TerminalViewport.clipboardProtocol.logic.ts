/**
 * kitty/Ghostty clipboard protocol (OSC 5522), terminal side, for reads only.
 * Spec: https://sw.kovidgoyal.net/kitty/clipboard/ and the paste-event addendum
 * https://rockorager.dev/misc/bracketed-paste-mime/.
 *
 * bigbud never prompts; it answers only from a snapshot of a real user paste gesture in this
 * pane, within a short window. With paste-event mode (`CSI ? 5522 h`) the paste is announced as
 * a MIME list with a one-time password instead of bracketed text, and reads must present it.
 */
import { bytesToBase64 } from "./TerminalViewport.paste.logic";

export const CLIPBOARD_PASTE_WINDOW_MS = 10_000;
/** Bytes per DATA packet before base64, as the spec requires. */
export const CLIPBOARD_CHUNK_BYTES = 4096;
const PASTE_EVENT_NAME = "Paste event";

export interface ClipboardSnapshotItem {
  readonly mime: string;
  readonly read: () => Promise<Uint8Array>;
  readonly size: number;
}

export interface ClipboardProtocolOptions {
  readonly now: () => number;
  readonly randomPassword: () => string;
  readonly enabled: () => boolean;
  readonly maxBytes: () => number;
}

const textEncoder = new TextEncoder();
const b64 = (text: string) => bytesToBase64(textEncoder.encode(text));

/** Strict RFC 4648 base64 (padding required, no whitespace); null when invalid. */
export function decodeBase64Text(value: string): string | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

export function parseClipboardRequest(data: string) {
  const separator = data.indexOf(";");
  const metadata = separator === -1 ? data : data.slice(0, separator);
  const payload = separator === -1 ? "" : data.slice(separator + 1);
  const keys = new Map<string, string>();
  for (const pair of metadata.split(":")) {
    const equals = pair.indexOf("=");
    if (equals > 0) keys.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  const id = (keys.get("id") ?? "").replace(/[^a-zA-Z0-9\-_+.]/g, "");
  return { keys, payload, id };
}

const packet = (metadata: string, id: string, payload?: string) =>
  `\x1b]5522;${metadata}${id ? `:id=${id}` : ""}${payload === undefined ? "" : `;${payload}`}\x1b\\`;

/** Per-pane protocol state; every reply is returned as bytes for the PTY. */
export class ClipboardProtocolState {
  pasteEventMode = false;
  private snapshot: {
    readonly items: ReadonlyArray<ClipboardSnapshotItem>;
    readonly at: number;
    password: string | null;
  } | null = null;
  private readBusy = false;

  constructor(private readonly options: ClipboardProtocolOptions) {}

  /** DECRQM reply: 1 set, 2 reset, 0 when the feature is disabled. */
  modeReport(): string {
    const value = !this.options.enabled() ? 0 : this.pasteEventMode ? 1 : 2;
    return `\x1b[?5522;${value}$y`;
  }

  reset(): void {
    this.pasteEventMode = false;
    this.snapshot = null;
  }

  /**
   * Records a real paste gesture. Returns the paste-event announcement when the program enabled
   * paste events (the caller then suppresses the normal paste), otherwise null.
   */
  onPasteGesture(items: ReadonlyArray<ClipboardSnapshotItem>): string | null {
    if (!this.options.enabled()) {
      this.snapshot = null;
      return null;
    }
    const password = this.pasteEventMode ? this.options.randomPassword() : null;
    this.snapshot = { items, at: this.options.now(), password };
    if (password === null) return null;
    const pw = `:pw=${b64(password)}`;
    const mimes = b64(items.map((item) => item.mime).join(" "));
    return (
      packet(`type=read:status=OK${pw}`, "") +
      packet(`type=read:status=DATA:mime=${b64(".")}${pw}`, "", mimes) +
      packet(`type=read:status=DONE${pw}`, "")
    );
  }

  /** Handles one OSC 5522 request; resolves to the reply bytes (or null to stay silent). */
  async handle(data: string): Promise<string | null> {
    const { keys, payload, id } = parseClipboardRequest(data);
    const type = keys.get("type");
    if (type === "write") return packet("type=write:status=EPERM", id);
    if (type !== "read") return null; // wdata/walias after a refused write are ignored.
    const requested = decodeBase64Text(payload);
    if (requested === null) return null; // Invalid base64 reads are ignored, per spec.
    if (keys.get("loc") === "primary") return packet("type=read:status=ENOSYS", id);
    if (this.readBusy) return packet("type=read:status=EBUSY", id);
    const snapshot = this.allowedSnapshot(keys);
    if (!snapshot) return packet("type=read:status=EPERM", id);
    const wanted = requested.trim().split(/\s+/).filter(Boolean);
    if (wanted.length === 1 && wanted[0] === ".") {
      const list = b64(snapshot.items.map((item) => item.mime).join(" "));
      return (
        packet("type=read:status=OK", id) +
        packet(`type=read:status=DATA:mime=${b64(".")}`, id, list) +
        packet("type=read:status=DONE", id)
      );
    }
    const items = wanted
      .map((mime) => snapshot.items.find((item) => item.mime === mime))
      .filter((item): item is ClipboardSnapshotItem => item !== undefined);
    if (items.reduce((total, item) => total + item.size, 0) > this.options.maxBytes())
      return packet("type=read:status=EPERM", id);
    // A password is single use: the snapshot it unlocked is spent.
    if (snapshot.password !== null) this.snapshot = null;
    this.readBusy = true;
    try {
      let reply = packet("type=read:status=OK", id);
      for (const item of items) {
        const bytes = await item.read();
        const mime = `type=read:status=DATA:mime=${b64(item.mime)}`;
        for (let offset = 0; offset < bytes.length; offset += CLIPBOARD_CHUNK_BYTES)
          reply += packet(
            mime,
            id,
            bytesToBase64(bytes.subarray(offset, offset + CLIPBOARD_CHUNK_BYTES)),
          );
      }
      return reply + packet("type=read:status=DONE", id);
    } finally {
      this.readBusy = false;
    }
  }

  private allowedSnapshot(keys: ReadonlyMap<string, string>) {
    const snapshot = this.snapshot;
    if (!snapshot || this.options.now() - snapshot.at > CLIPBOARD_PASTE_WINDOW_MS) return null;
    if (snapshot.password === null) return snapshot;
    const password = decodeBase64Text(keys.get("pw") ?? "");
    const name = decodeBase64Text(keys.get("name") ?? "");
    // A password without a name counts as no password (spec); the name is "Paste event".
    return password === snapshot.password && name === PASTE_EVENT_NAME ? snapshot : null;
  }
}

import { describe, expect, it } from "vitest";
import {
  CLIPBOARD_PASTE_WINDOW_MS,
  ClipboardProtocolState,
  decodeBase64Text,
  parseClipboardRequest,
} from "./TerminalViewport.clipboardProtocol.logic";

const b64 = (text: string) => btoa(text);
const ST = "\x1b\\";
const png = new Uint8Array(5000).fill(7);

function harness(overrides: { enabled?: boolean; maxBytes?: number } = {}) {
  let now = 1_000;
  const state = new ClipboardProtocolState({
    now: () => now,
    randomPassword: () => "one-time-secret",
    enabled: () => overrides.enabled ?? true,
    maxBytes: () => overrides.maxBytes ?? 20 * 1024 * 1024,
  });
  const items = [
    { mime: "text/plain", size: 2, read: async () => new TextEncoder().encode("hi") },
    { mime: "image/png", size: png.length, read: async () => png },
  ];
  return {
    state,
    items,
    advance: (ms: number) => (now += ms),
  };
}

const read = (mimes: string, extra = "") => `type=read${extra};${b64(mimes)}`;

describe("OSC 5522 clipboard protocol", () => {
  it("parses metadata, payload and strips unsafe id characters", () => {
    const parsed = parseClipboardRequest("type=read:id=a b/c-1;Lg==");
    expect(parsed.keys.get("type")).toBe("read");
    expect(parsed.id).toBe("abc-1");
    expect(parsed.payload).toBe("Lg==");
    expect(decodeBase64Text("Lg==")).toBe(".");
    expect(decodeBase64Text("Lg")).toBeNull();
    expect(decodeBase64Text("L g=")).toBeNull();
  });

  it("denies reads with no paste gesture in this pane, or after the window", async () => {
    const test = harness();
    expect(await test.state.handle(read("text/plain"))).toBe(
      `\x1b]5522;type=read:status=EPERM${ST}`,
    );
    test.state.onPasteGesture(test.items);
    test.advance(CLIPBOARD_PASTE_WINDOW_MS + 1);
    expect(await test.state.handle(read("image/png", ":id=mux1"))).toBe(
      `\x1b]5522;type=read:status=EPERM:id=mux1${ST}`,
    );
  });

  it("answers a read right after a paste with 4096-byte DATA chunks", async () => {
    const test = harness();
    expect(test.state.onPasteGesture(test.items)).toBeNull();
    const reply = (await test.state.handle(read("image/png")))!;
    const packets = reply.split(ST).filter(Boolean);
    expect(packets[0]).toBe("\x1b]5522;type=read:status=OK");
    expect(packets.at(-1)).toBe("\x1b]5522;type=read:status=DONE");
    const data = packets.slice(1, -1);
    expect(data).toHaveLength(2);
    expect(data[0]!.startsWith(`\x1b]5522;type=read:status=DATA:mime=${b64("image/png")};`)).toBe(
      true,
    );
    const bytes = data.map((packet) => atob(packet.split(";").at(-1)!).length);
    expect(bytes).toEqual([4096, 904]);
  });

  it("lists MIME types and refuses primary selection, writes and oversized reads", async () => {
    const test = harness({ maxBytes: 100 });
    test.state.onPasteGesture(test.items);
    const listing = (await test.state.handle(read(".")))!;
    expect(listing).toContain(`mime=${b64(".")};${b64("text/plain image/png")}`);
    expect(await test.state.handle(read("text/plain", ":loc=primary"))).toContain("status=ENOSYS");
    expect(await test.state.handle("type=write")).toBe(`\x1b]5522;type=write:status=EPERM${ST}`);
    expect(await test.state.handle(read("image/png"))).toContain("status=EPERM");
    expect(await test.state.handle("type=read;not base64!")).toBeNull();
  });

  it("announces paste events with a one-time password that unlocks exactly one read", async () => {
    const test = harness();
    test.state.pasteEventMode = true;
    const announcement = test.state.onPasteGesture(test.items)!;
    const pw = `:pw=${b64("one-time-secret")}`;
    expect(announcement).toBe(
      `\x1b]5522;type=read:status=OK${pw}${ST}` +
        `\x1b]5522;type=read:status=DATA:mime=${b64(".")}${pw};${b64("text/plain image/png")}${ST}` +
        `\x1b]5522;type=read:status=DONE${pw}${ST}`,
    );
    expect(await test.state.handle(read("text/plain"))).toContain("EPERM");
    expect(await test.state.handle(read("text/plain", pw))).toContain("EPERM"); // no name
    const name = `:name=${b64("Paste event")}`;
    expect(await test.state.handle(read("text/plain", `${pw}${name}`))).toContain(
      `;${b64("hi")}${ST}`,
    );
    expect(await test.state.handle(read("text/plain", `${pw}${name}`))).toContain("EPERM");
  });

  it("reports the mode and goes silent on paste events when disabled", async () => {
    const test = harness();
    expect(test.state.modeReport()).toBe("\x1b[?5522;2$y");
    test.state.pasteEventMode = true;
    expect(test.state.modeReport()).toBe("\x1b[?5522;1$y");
    test.state.reset();
    expect(test.state.modeReport()).toBe("\x1b[?5522;2$y");
    const off = harness({ enabled: false });
    off.state.pasteEventMode = true;
    expect(off.state.modeReport()).toBe("\x1b[?5522;0$y");
    expect(off.state.onPasteGesture(off.items)).toBeNull();
    expect(await off.state.handle(read("text/plain"))).toContain("EPERM");
  });
});

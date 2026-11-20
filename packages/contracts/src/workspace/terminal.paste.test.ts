import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ServerSettings, ServerSettingsPatch } from "../core/settings";
import { TERMINAL_PASTE_CHUNK_BYTES, TerminalPasteStageInput } from "./terminal.paste";

const decode = Schema.decodeUnknownSync(TerminalPasteStageInput);

describe("terminal paste staging contract", () => {
  it("never accepts a client-chosen machine and defaults the terminal", () => {
    const begin = decode({
      op: "begin",
      threadId: "thread-1",
      fileName: "a.png",
      mimeType: "image/png",
      byteLength: 3,
      executionTargetId: "ssh:host=elsewhere",
    });
    expect(begin).toMatchObject({ op: "begin", terminalId: "default" });
    expect(begin).not.toHaveProperty("executionTargetId");
  });

  it("bounds chunks and validates identifiers and digests", () => {
    const maxBase64 = Math.ceil(TERMINAL_PASTE_CHUNK_BYTES / 3) * 4;
    const uploadId = "0123456789abcdef";
    expect(() =>
      decode({ op: "chunk", uploadId, offset: 0, data: "A".repeat(maxBase64) }),
    ).not.toThrow();
    expect(() =>
      decode({ op: "chunk", uploadId, offset: 0, data: "A".repeat(maxBase64 + 4) }),
    ).toThrow();
    expect(() => decode({ op: "chunk", uploadId, offset: 0, data: "not base64!" })).toThrow();
    expect(() => decode({ op: "chunk", uploadId: "../x", offset: 0, data: "" })).toThrow();
    expect(() => decode({ op: "commit", uploadId, sha256: "zz" })).toThrow();
    expect(() =>
      decode({ op: "begin", threadId: "t", fileName: "", mimeType: "", byteLength: 0 }),
    ).toThrow();
  });

  it("defaults the paste size cap to 20 MB with a 10 MB minimum", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({});
    expect(settings.terminalPasteMaxFileMb).toBe(20);
    expect(settings.terminalClipboardRequests).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(ServerSettingsPatch)({ terminalPasteMaxFileMb: 5 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ServerSettingsPatch)({ terminalPasteMaxFileMb: 50 }),
    ).not.toThrow();
  });
});

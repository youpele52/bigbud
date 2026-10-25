import { expect, it, vi, afterEach } from "vitest";
import { getProviderDescriptor } from "../provider/providerDescriptors";
import { desktopAttachmentPath } from "./ChatView.attachments.logic";

afterEach(() => vi.unstubAllGlobals());
it("restores V2 attachment admission without affecting catalog/provider selection", () => {
  const v2 = getProviderDescriptor("opencodeV2");
  expect(v2.attachments?.supported).toBe(true);
  expect(v2.attachments?.unavailableReason).toBeUndefined();
  expect(v2.pickerAvailable).toBe(true);
  expect(getProviderDescriptor("opencode").attachments).toBeUndefined();
  expect(getProviderDescriptor("kilocode").attachments).toBeUndefined();
});
it("accepts genuine Electron paths but falls back for browser/clipboard files or bridge errors", () => {
  const file = {} as File;
  for (const result of ["", "C:\\fakepath\\notes.txt", "notes.txt"]) {
    vi.stubGlobal("window", { desktopBridge: { getFilePath: () => result } });
    expect(desktopAttachmentPath(file)).toBe("");
  }
  for (const result of ["/Users/user/notes.txt", "C:\\files\\notes.txt"]) {
    vi.stubGlobal("window", { desktopBridge: { getFilePath: () => result } });
    expect(desktopAttachmentPath(file)).toBe(result);
  }
  vi.stubGlobal("window", {
    desktopBridge: {
      getFilePath: () => {
        throw new Error("clipboard");
      },
    },
  });
  expect(desktopAttachmentPath(file)).toBe("");
});

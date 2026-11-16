import { MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ThreadDetailMessage } from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import { THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD } from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import { describe, expect, it } from "vitest";

import {
  isOversizedMobileRecord,
  mobileTextFromDetailMessage,
  mobileTooLargeNotice,
  previewMobileText,
  withMobileTooLargeNotice,
} from "./mobileRecordBounds.ts";

const KB = 1024;

function detailMessage(overrides: Partial<ThreadDetailMessage>): ThreadDetailMessage {
  return {
    id: MessageId.makeUnsafe("detail-message"),
    role: "assistant",
    text: "preview",
    attachments: [],
    attachmentsTruncated: false,
    turnId: null,
    streaming: false,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("mobileRecordBounds", () => {
  it("states the full size in KB, rounded up, in the notice", () => {
    expect(mobileTooLargeNotice(300 * KB)).toBe(
      "\n\n— This message is too large for mobile (300 KB). Open it on the desktop to read all of it.",
    );
    expect(mobileTooLargeNotice(300 * KB + 1)).toContain("(301 KB)");
    expect(mobileTooLargeNotice(10)).toContain("(1 KB)");
    expect(withMobileTooLargeNotice("head", 300 * KB)).toBe(
      `head${mobileTooLargeNotice(300 * KB)}`,
    );
  });

  it("flags only records over the detail truncation threshold", () => {
    expect(isOversizedMobileRecord(THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD)).toBe(false);
    expect(isOversizedMobileRecord(THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD + 1)).toBe(true);
    expect(isOversizedMobileRecord(null)).toBe(false);
    expect(isOversizedMobileRecord(undefined)).toBe(false);
  });

  it("previews long text with the notice and leaves short text alone", () => {
    expect(previewMobileText("short", 2 * KB)).toBe("short");
    expect(previewMobileText("x".repeat(10 * KB), 2 * KB)).toBe(
      withMobileTooLargeNotice("x".repeat(2 * KB), 10 * KB),
    );
    // An already-bounded row reports its stored length, not the preview's.
    expect(previewMobileText("y".repeat(10 * KB), 2 * KB, 400 * KB)).toContain("(400 KB)");
  });

  it("never grows text and never splits a surrogate pair", () => {
    const barelyOver = "z".repeat(2 * KB + 10);
    expect(previewMobileText(barelyOver, 2 * KB)).toBe(barelyOver);

    const emoji = "😀".repeat(4 * KB);
    const preview = previewMobileText(emoji, 2 * KB + 1);
    const head = preview.slice(0, preview.indexOf("\n\n— "));
    expect(head).toBe("😀".repeat(KB));
    expect(new TextEncoder().encode(head).byteLength).toBe(4 * KB);
  });

  it("appends the notice to a truncated desktop detail message only", () => {
    expect(mobileTextFromDetailMessage(detailMessage({}))).toBe("preview");
    expect(
      mobileTextFromDetailMessage(detailMessage({ textTruncated: true, textLength: 512 * KB })),
    ).toBe(withMobileTooLargeNotice("preview", 512 * KB));
  });
});

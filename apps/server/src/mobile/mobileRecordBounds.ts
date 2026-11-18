import {
  THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD,
  type ThreadDetailMessage,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";

/**
 * Serialized-JSON budget for one mobile recovery baseline. The phone gateway closes the socket on
 * any message over 4 MiB, so the baseline stays well below it, leaving room for the RPC envelope.
 */
export const MOBILE_BASELINE_MAX_BYTES = 3 * 1024 * 1024;

/** Summary message preview length once the baseline has to shed bytes to fit its budget. */
export const MOBILE_DEGRADED_TEXT_PREVIEW_LENGTH = 2 * 1024;

export const MOBILE_BASELINE_TOO_LARGE_MESSAGE =
  "Too much recent activity to load on mobile. Open it on the desktop.";

/** True when a stored record of `length` characters is over the per-record mobile limit. */
export function isOversizedMobileRecord(length: number | null | undefined): length is number {
  return length !== null && length !== undefined && length > THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD;
}

/** The notice appended to a preview; `fullLength` is the stored length in characters. */
export function mobileTooLargeNotice(fullLength: number): string {
  const kilobytes = Math.max(1, Math.ceil(fullLength / 1024));
  return `\n\n— This message is too large for mobile (${kilobytes} KB). Open it on the desktop to read all of it.`;
}

export function withMobileTooLargeNotice(preview: string, fullLength: number): string {
  return `${preview}${mobileTooLargeNotice(fullLength)}`;
}

/** Cuts at `maxLength` UTF-16 units without splitting a surrogate pair. */
function cutWithoutSplittingPairs(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const lastKept = text.charCodeAt(maxLength - 1);
  const splitsPair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return text.slice(0, splitsPair ? maxLength - 1 : maxLength);
}

/**
 * A `maxLength` preview of `text` with the too-large notice, or `text` unchanged when it already
 * fits or the preview would not be shorter. `fullLength` is the stored length, which is larger
 * than `text` for an already-bounded row.
 */
export function previewMobileText(
  text: string,
  maxLength: number,
  fullLength: number = text.length,
): string {
  if (text.length <= maxLength) return text;
  const preview = withMobileTooLargeNotice(cutWithoutSplittingPairs(text, maxLength), fullLength);
  return preview.length < text.length ? preview : text;
}

/** Desktop detail text for the phone: a truncated preview keeps its preview plus the notice. */
export function mobileTextFromDetailMessage(message: ThreadDetailMessage): string {
  return message.textTruncated === true && message.textLength !== undefined
    ? withMobileTooLargeNotice(message.text, message.textLength)
    : message.text;
}

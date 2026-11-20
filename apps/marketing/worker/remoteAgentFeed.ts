import { GITHUB_REPO_SLUG } from "../src/constants/app";
import { normalizeReleaseTag } from "./remoteAgentRelease";

/**
 * Pure parsing of GitHub's public releases Atom feed, the token-free fallback when the REST API is
 * rate limited. Workers have no DOMParser, so entries are found with bounded string scanning and
 * every tag is re-validated with the shared release version format. No Workers globals.
 */

/** Larger feeds are treated as unusable rather than parsed. */
export const MAX_FEED_BYTES = 1024 * 1024;
export const MAX_FEED_ENTRIES = 100;
const MAX_TAG_LENGTH = 64;
const ENTRY_OPEN = "<entry";
const ENTRY_CLOSE = "</entry>";

export function remoteAgentReleasesFeedUrl(): string {
  return `https://github.com/${GITHUB_REPO_SLUG}/releases.atom`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FEED_ROOT = /<feed\b[^>]*>/;
const LINK_TAG = new RegExp(
  `<link\\b[^>]*\\bhref=["']https://github\\.com/${escapeRegExp(GITHUB_REPO_SLUG)}/releases/tag/([^"'/?#<>\\s]{1,${MAX_TAG_LENGTH}})["']`,
);
const ID_TAG = new RegExp(
  `<id>\\s*tag:github\\.com,2008:Repository/\\d{1,20}/([^<\\s]{1,${MAX_TAG_LENGTH}})\\s*</id>`,
);

function entryTag(entry: string): string | null {
  const raw = LINK_TAG.exec(entry)?.[1] ?? ID_TAG.exec(entry)?.[1];
  if (!raw) return null;
  try {
    return normalizeReleaseTag(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/**
 * Valid release tags in feed order (the `<link>` tag URL, else the `<id>`), or `null` when the
 * document is oversized or not an Atom feed. Entries with an invalid tag are dropped, and an
 * unterminated entry ends the scan, so the work stays linear in the (capped) body size.
 */
export function parseReleaseFeedTags(xml: string): string[] | null {
  if (xml.length > MAX_FEED_BYTES || !FEED_ROOT.test(xml)) return null;
  const tags: string[] = [];
  let cursor = 0;
  for (let entries = 0; entries < MAX_FEED_ENTRIES; entries += 1) {
    const start = xml.indexOf(ENTRY_OPEN, cursor);
    if (start === -1) break;
    const end = xml.indexOf(ENTRY_CLOSE, start);
    if (end === -1) break;
    const tag = entryTag(xml.slice(start, end));
    if (tag) tags.push(tag);
    cursor = end + ENTRY_CLOSE.length;
  }
  return tags;
}

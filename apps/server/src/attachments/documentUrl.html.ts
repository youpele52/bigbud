import { setImmediate } from "node:timers/promises";
import { EXTRACTED_DOCUMENT_MAX_CHARS, truncateExtractedText } from "./documentText.shared.ts";

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};
const RAW_TAGS = new Set(["title", "script", "style", "noscript", "textarea"]);
const BREAK_TAG = /^(?:br|\/(?:p|div|section|article|li|tr|h\d))$/;

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]{2,5});/gi,
    (original: string, entity: string) => {
      if (!entity.startsWith("#"))
        return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity]! : original;
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
        ? "�"
        : String.fromCodePoint(point);
    },
  );
}

function markupAt(html: string, start: number): { end: number; tag: string } | null {
  if (html.startsWith("<!--", start)) {
    const close = html.indexOf("-->", start + 4);
    return { end: close < 0 ? html.length : close + 3, tag: "" };
  }
  const tagStart = start + 1;
  const declaration = html[tagStart] === "!" || html[tagStart] === "?";
  const nameStart = html[tagStart] === "/" ? tagStart + 1 : tagStart;
  if (!declaration && !/[a-z]/i.test(html[nameStart] ?? "")) return null;
  let cursor = declaration ? tagStart + 1 : nameStart + 1;
  if (!declaration) while (cursor < html.length && /[a-z\d:_-]/i.test(html[cursor]!)) cursor++;
  // Names of interest are short; there is no reason to materialize a giant tag name.
  const tag =
    declaration || cursor - tagStart > 16 ? "" : html.slice(tagStart, cursor).toLowerCase();
  let quote: string | undefined;
  let attribute: "name" | "before-value" | "unquoted" = "name";
  for (; cursor < html.length; cursor++) {
    const char = html[cursor]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === ">") return { end: cursor + 1, tag };
    if (attribute === "before-value") {
      if (/\s/.test(char)) continue;
      if (char === '"' || char === "'") {
        quote = char;
        attribute = "name";
      } else attribute = "unquoted";
      continue;
    }
    if (attribute === "unquoted") {
      if (/\s/.test(char)) attribute = "name";
      continue;
    }
    if (char === "=") attribute = "before-value";
    else if (declaration && (char === '"' || char === "'")) quote = char;
    else if (char === "<") {
      // Resume at the next possible tag; never rescan an unclosed prefix.
      return { end: cursor, tag: "" };
    }
  }
  return { end: html.length, tag: "" };
}

function rawCloseAt(html: string, offset: number, tag: string) {
  const nameEnd = offset + tag.length + 2;
  if (
    html.slice(offset, nameEnd).toLowerCase() !== `</${tag}` ||
    !/[\s/>]/.test(html[nameEnd] ?? "")
  ) {
    return null;
  }
  return markupAt(html, offset);
}

function boundedBodyText() {
  const limit = EXTRACTED_DOCUMENT_MAX_CHARS + 1;
  let text = "";
  let space = "";
  return {
    get full() {
      return text.length >= limit;
    },
    get value() {
      return truncateExtractedText(text);
    },
    append(value: string) {
      for (const [token] of decodeEntities(value).matchAll(/\s+|\S+/g)) {
        if (/^\s/.test(token)) {
          if (token.includes("\n") || token.includes("\r")) {
            space =
              space.includes("\n") || /[\r\n][\s]*[\r\n]/.test(token.replaceAll("\r\n", "\n"))
                ? "\n\n"
                : "\n";
          } else if (!space) space = " ";
          continue;
        }
        if (text) text += space;
        text += token.slice(0, Math.max(0, limit - text.length));
        space = "";
        if (text.length >= limit) break;
      }
    },
  };
}

export async function extractHtmlDocument(
  html: string,
  fallbackTitle: string,
  signal?: AbortSignal,
) {
  const body = boundedBodyText();
  let title: string | undefined;
  let raw: { tag: string; start: number } | undefined;
  let cursor = 0;
  let nextYield = 0;
  while (cursor < html.length && !body.full) {
    if (cursor >= nextYield) {
      await setImmediate(undefined, { signal });
      nextYield = cursor + 128 * 1024;
    }
    const start = html.indexOf("<", cursor);
    if (start < 0) {
      if (!raw) body.append(html.slice(cursor));
      break;
    }
    if (raw) {
      const close = rawCloseAt(html, start, raw.tag);
      if (!close) {
        cursor = start + 1;
        continue;
      }
      if (raw.tag === "title" && title === undefined) {
        title = decodeEntities(html.slice(raw.start, Math.min(start, raw.start + 4096))).trim();
      }
      raw = undefined;
      cursor = close.end;
      continue;
    }
    if (start > cursor) body.append(html.slice(cursor, start));
    if (body.full) break;
    const token = markupAt(html, start);
    if (!token) {
      body.append("<");
      cursor = start + 1;
      continue;
    }
    cursor = token.end;
    if (RAW_TAGS.has(token.tag)) raw = { tag: token.tag, start: cursor };
    body.append(BREAK_TAG.test(token.tag) ? "\n" : " ");
  }
  signal?.throwIfAborted();
  return { title: (title || fallbackTitle).slice(0, 256).trimEnd() || null, text: body.value };
}

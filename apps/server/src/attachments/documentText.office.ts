import { setImmediate } from "node:timers/promises";
import { extractOfficeZipEntries } from "./documentText.office.zip.ts";
import { EXTRACTED_DOCUMENT_MAX_CHARS } from "./documentText.shared.ts";

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeOfficeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function* extractXmlText(xml: string, pattern: RegExp) {
  for (const match of xml.matchAll(pattern)) {
    const text = decodeXmlEntities(match[1] ?? "").trim();
    if (text) yield text;
  }
}

// Scan structural boundaries once; malformed XML cannot repeatedly rescan the remaining document.
function* xmlContainers(xml: string, pattern: RegExp) {
  let open: RegExpMatchArray | undefined;
  for (const match of xml.matchAll(pattern)) {
    if (match[0].startsWith("</")) {
      if (open)
        yield {
          attributes: open[1] ?? "",
          body: xml.slice(open.index! + open[0].length, match.index),
        };
      open = undefined;
    } else if (!match[0].endsWith("/>")) open = match;
  }
}

function officePreview() {
  const limit = EXTRACTED_DOCUMENT_MAX_CHARS + 1;
  let text = "";
  return {
    get complete() {
      return text.length >= limit;
    },
    value: () => text,
    append(value: string, separator: string) {
      const normalized = normalizeOfficeText(value);
      if (!normalized) return;
      if (text) text += separator;
      text += normalized.slice(0, Math.max(0, limit - text.length));
    },
  };
}

export async function extractDocxTextFromBuffer(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const entries = await extractOfficeZipEntries(
    bytes,
    (name) => name === "word/document.xml",
    signal,
  );
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) return "";
  const xml = documentXml.toString("utf8");
  const text = xml
    .replace(/<w:tab\b[^<>]*\/>/g, "\t")
    .replace(/<w:br\b[^<>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^<>]+>/g, "");
  return normalizeOfficeText(decodeXmlEntities(text));
}

const PPTX_SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;
const XLSX_SHEET = /^xl\/worksheets\/sheet(\d+)\.xml$/;
const XML_TEXT = /<t(?:\s[^<>]*)?>([^<]*)<\/t>/g;

function orderedParts(entries: Map<string, Buffer>, pattern: RegExp) {
  return [...entries.entries()]
    .filter(([name]) => pattern.test(name))
    .toSorted(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
}

export async function extractPptxTextFromBuffer(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const entries = await extractOfficeZipEntries(bytes, (name) => PPTX_SLIDE.test(name), signal);
  const preview = officePreview();
  for (const [name, xml] of orderedParts(entries, PPTX_SLIDE)) {
    await setImmediate(undefined, { signal });
    let hasTitle = false;
    for (const run of extractXmlText(xml.toString("utf8"), /<a:t(?:\s[^<>]*)?>([^<]*)<\/a:t>/g)) {
      if (!hasTitle) {
        preview.append(`Slide ${PPTX_SLIDE.exec(name)?.[1]}`, "\n\n");
        hasTitle = true;
      }
      preview.append(run, "\n");
      if (preview.complete) return preview.value();
    }
  }
  return preview.value();
}

function sheetCellValue(attributes: string, body: string, strings: readonly string[]) {
  const inline = [...extractXmlText(body, XML_TEXT)].join("");
  if (inline) return inline;
  const value = /<v(?:\s[^<>]*)?>([^<]*)<\/v>/.exec(body)?.[1]?.trim() ?? "";
  if (/(?:^|\s)t="s"/.test(attributes)) return strings[Number.parseInt(value, 10)] ?? "";
  return decodeXmlEntities(value);
}

export async function extractXlsxTextFromBuffer(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const entries = await extractOfficeZipEntries(
    bytes,
    (name) =>
      name === "xl/sharedStrings.xml" || name === "xl/workbook.xml" || XLSX_SHEET.test(name),
    signal,
  );
  const sharedStrings = [
    ...extractXmlText(entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "", XML_TEXT),
  ];
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const sheetNames = [...extractXmlText(workbook, /<sheet\s[^<>]*?\s?\bname="([^"<>]*)"/g)];
  const preview = officePreview();
  for (const [index, [name, xml]] of orderedParts(entries, XLSX_SHEET).entries()) {
    await setImmediate(undefined, { signal });
    let hasTitle = false;
    let rowCount = 0;
    for (const row of xmlContainers(xml.toString("utf8"), /<row\b([^<>]*)>|<\/row>/g)) {
      if (++rowCount % 128 === 0) await setImmediate(undefined, { signal });
      let hasCell = false;
      for (const cell of xmlContainers(row.body, /<c\b([^<>]*)>|<\/c>/g)) {
        const value = sheetCellValue(cell.attributes, cell.body, sharedStrings);
        if (!value.trim()) continue;
        if (!hasTitle) {
          preview.append(sheetNames[index] || `Sheet ${XLSX_SHEET.exec(name)?.[1]}`, "\n\n");
          hasTitle = true;
        }
        preview.append(value, hasCell ? "\t" : "\n");
        hasCell = true;
        if (preview.complete) return preview.value();
      }
    }
  }
  return preview.value();
}

import { inflateRawSync } from "node:zlib";

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

function extractZipEntries(bytes: Buffer): Map<string, Buffer> {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const maxCommentLength = 0xffff;
  const searchStart = Math.max(0, bytes.length - (maxCommentLength + 22));
  let eocdOffset = -1;

  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return new Map();

  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  let centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(centralOffset) !== centralSignature) {
      return new Map();
    }

    const compressionMethod = bytes.readUInt16LE(centralOffset + 10);
    const compressedSize = bytes.readUInt32LE(centralOffset + 20);
    const fileNameLength = bytes.readUInt16LE(centralOffset + 28);
    const extraLength = bytes.readUInt16LE(centralOffset + 30);
    const commentLength = bytes.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = bytes.readUInt32LE(centralOffset + 42);
    const fileName = bytes.toString(
      "utf8",
      centralOffset + 46,
      centralOffset + 46 + fileNameLength,
    );

    if (bytes.readUInt32LE(localHeaderOffset) !== localSignature) {
      return new Map();
    }

    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      entries.set(fileName, data);
    } else if (compressionMethod === 8) {
      entries.set(fileName, inflateRawSync(data));
    }

    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function extractXmlText(xml: string, pattern: RegExp): string[] {
  return Array.from(xml.matchAll(pattern), (match) =>
    decodeXmlEntities(match[1] ?? "").trim(),
  ).filter((value) => value.length > 0);
}

export function extractDocxTextFromBuffer(bytes: Uint8Array): string {
  const entries = extractZipEntries(Buffer.from(bytes));
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) return "";

  const xml = documentXml.toString("utf8");
  const text = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "");
  return normalizeOfficeText(decodeXmlEntities(text));
}

export function extractPptxTextFromBuffer(bytes: Uint8Array): string {
  const entries = extractZipEntries(Buffer.from(bytes));
  const slides = [...entries.entries()]
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .toSorted(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));

  const blocks = slides.flatMap(([name, xmlBytes], index) => {
    const textRuns = extractXmlText(xmlBytes.toString("utf8"), /<a:t[^>]*>([\s\S]*?)<\/a:t>/g);
    if (textRuns.length === 0) return [];
    const slideNumber = Number.parseInt(name.match(/slide(\d+)\.xml$/)?.[1] ?? `${index + 1}`, 10);
    return [`Slide ${slideNumber}\n${textRuns.join("\n")}`];
  });

  return normalizeOfficeText(blocks.join("\n\n"));
}

export function extractXlsxTextFromBuffer(bytes: Uint8Array): string {
  const entries = extractZipEntries(Buffer.from(bytes));
  const sharedStringsXml = entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const sharedStrings = extractXmlText(sharedStringsXml, /<t[^>]*>([\s\S]*?)<\/t>/g);
  const workbookXml = entries.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const sheetNames = Array.from(workbookXml.matchAll(/<sheet[^>]* name="([^"]+)"/g), (match) =>
    decodeXmlEntities(match[1] ?? "").trim(),
  );

  const sheets = [...entries.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .toSorted(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));

  const renderedSheets = sheets.flatMap(([name, xmlBytes], index) => {
    const sheetXml = xmlBytes.toString("utf8");
    const rows = Array.from(sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g), (rowMatch) => {
      const rowBody = rowMatch[1] ?? "";
      const cells = Array.from(
        rowBody.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g),
        ([, attributes, content]) => {
          const cellAttributes = attributes ?? "";
          const cellContent = content ?? "";
          const cellType = /(?:^|\s)t="([^"]+)"/.exec(cellAttributes)?.[1];
          const inlineText = extractXmlText(cellContent, /<t[^>]*>([\s\S]*?)<\/t>/g).join("");
          if (inlineText.length > 0) return inlineText;

          const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellContent)?.[1]?.trim() ?? "";
          if (value.length === 0) return "";
          if (cellType === "s") {
            const sharedIndex = Number.parseInt(value, 10);
            return Number.isNaN(sharedIndex) ? "" : (sharedStrings[sharedIndex] ?? "");
          }
          return decodeXmlEntities(value);
        },
      ).filter((cell) => cell.length > 0);
      return cells.join("\t");
    }).filter((row) => row.length > 0);

    if (rows.length === 0) return [];
    const sheetNumber = Number.parseInt(name.match(/sheet(\d+)\.xml$/)?.[1] ?? `${index + 1}`, 10);
    const sheetName = sheetNames[index] || `Sheet ${sheetNumber}`;
    return [`${sheetName}\n${rows.join("\n")}`];
  });

  return normalizeOfficeText(renderedSheets.join("\n\n"));
}

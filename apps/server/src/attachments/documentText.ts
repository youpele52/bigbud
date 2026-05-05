import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";

import { isTextReadable } from "./fileMime.ts";

const execAsync = promisify(exec);

export const EXTRACTED_DOCUMENT_MAX_CHARS = 32_000;

const PDF_MIME_TYPE = "application/pdf";
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateExtractedText(value: string): string {
  if (value.length <= EXTRACTED_DOCUMENT_MAX_CHARS) return value;
  return `${value.slice(0, EXTRACTED_DOCUMENT_MAX_CHARS).trimEnd()}\n\n[Document text truncated]`;
}

// ── PDF ───────────────────────────────────────────────────────────────────────

/**
 * Extract text from a PDF using the system `pdftotext` binary (Poppler).
 *
 * `pdftotext` handles CID-keyed fonts and ToUnicode CMaps — the encoding used
 * by virtually all real-world PDFs produced by Word, LaTeX, Adobe, etc.
 * Returns `null` when the binary is not installed or extraction yields nothing.
 *
 * On macOS install via: brew install poppler
 * On Linux install via: apt install poppler-utils
 */
async function extractPdfTextWithPdftotext(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`pdftotext -enc UTF-8 -- ${JSON.stringify(filePath)} -`, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
    });
    const normalized = normalizeExtractedText(stdout);
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

// ── DOCX ──────────────────────────────────────────────────────────────────────

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractDocxEntry(bytes: Buffer, entryName: string): Buffer | null {
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
  if (eocdOffset < 0) return null;

  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  let centralOffset = bytes.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(centralOffset) !== centralSignature) return null;
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

    if (fileName === entryName) {
      if (bytes.readUInt32LE(localHeaderOffset) !== localSignature) return null;
      const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === 0) return data;
      if (compressionMethod === 8) return inflateRawSync(data);
      return null;
    }

    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return null;
}

export function extractDocxTextFromBuffer(bytes: Uint8Array): string {
  const documentXml = extractDocxEntry(Buffer.from(bytes), "word/document.xml");
  if (!documentXml) return "";

  const xml = documentXml.toString("utf8");
  const text = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "");
  return normalizeExtractedText(decodeXmlEntities(text));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function supportsPromptTextExtraction(input: {
  readonly mimeType: string;
  readonly fileName: string;
}): boolean {
  const mimeType = input.mimeType.toLowerCase();
  const fileName = input.fileName.toLowerCase();
  return (
    isTextReadable(mimeType) ||
    mimeType === PDF_MIME_TYPE ||
    mimeType === DOCX_MIME_TYPE ||
    fileName.endsWith(".pdf") ||
    fileName.endsWith(".docx")
  );
}

export async function extractPromptTextFromFile(input: {
  readonly filePath: string;
  readonly mimeType: string;
  readonly fileName: string;
}): Promise<string | null> {
  const mimeType = input.mimeType.toLowerCase();
  const fileName = input.fileName.toLowerCase();

  if (isTextReadable(mimeType)) {
    return normalizeExtractedText(await readFile(input.filePath, "utf8"));
  }

  if (mimeType === PDF_MIME_TYPE || fileName.endsWith(".pdf")) {
    const text = await extractPdfTextWithPdftotext(input.filePath);
    return text !== null ? truncateExtractedText(text) : null;
  }

  if (mimeType === DOCX_MIME_TYPE || fileName.endsWith(".docx")) {
    const text = extractDocxTextFromBuffer(await readFile(input.filePath));
    return text.length > 0 ? truncateExtractedText(text) : null;
  }

  return null;
}

export function formatAttachedFileContents(
  blocks: ReadonlyArray<{ readonly fileName: string; readonly text: string }>,
): string {
  return `<attached_file_contents>\n${blocks
    .map((block) => `<file name="${block.fileName}">\n${block.text}\n</file>`)
    .join("\n")}\n</attached_file_contents>`;
}

export function appendAttachedFileContents(
  prompt: string,
  blocks: ReadonlyArray<{ readonly fileName: string; readonly text: string }>,
): string {
  if (blocks.length === 0) return prompt;
  const attachedFiles = formatAttachedFileContents(blocks);
  return prompt.length > 0 ? `${prompt}\n\n${attachedFiles}` : attachedFiles;
}

export function formatUnextractableFileNotice(
  files: ReadonlyArray<{ readonly fileName: string; readonly mimeType: string }>,
): string {
  return `<unreadable_attached_files>\n${files
    .map(
      (file) =>
        `- ${file.fileName} (${file.mimeType}): text could not be extracted. Do not call file-reading tools on this attachment path; ask the user for a text-readable version or OCR if its contents are required.`,
    )
    .join("\n")}\n</unreadable_attached_files>`;
}

export function appendUnextractableFileNotice(
  prompt: string,
  files: ReadonlyArray<{ readonly fileName: string; readonly mimeType: string }>,
): string {
  if (files.length === 0) return prompt;
  const notice = formatUnextractableFileNotice(files);
  return prompt.length > 0 ? `${prompt}\n\n${notice}` : notice;
}

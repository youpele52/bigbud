import { exec } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { isTextReadable } from "./fileMime.ts";
import {
  extractOcrTextFromBuffer,
  extractOcrTextFromFile,
  supportsOcrTextExtraction,
} from "./documentText.ocr.ts";
import {
  extractDocxTextFromBuffer,
  extractPptxTextFromBuffer,
  extractXlsxTextFromBuffer,
} from "./documentText.office.ts";
import {
  EXTRACTED_DOCUMENT_MAX_CHARS,
  normalizeExtractedText,
  truncateExtractedText,
} from "./documentText.shared.ts";

export { extractDocxTextFromBuffer } from "./documentText.office.ts";
export { EXTRACTED_DOCUMENT_MAX_CHARS } from "./documentText.shared.ts";

const execAsync = promisify(exec);

const PDF_MIME_TYPE = "application/pdf";
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const TEXT_FILE_EXTENSIONS = [
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".ts",
  ".js",
  ".py",
  ".rs",
  ".go",
  ".css",
  ".html",
];

function isTextReadableFileName(fileName: string): boolean {
  return TEXT_FILE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
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

async function extractPdfTextFromBuffer(bytes: Uint8Array): Promise<string | null> {
  const tempDir = await mkdtemp(join(tmpdir(), "bigbud-pdf-buffer-"));
  const tempPath = join(tempDir, "document.pdf");
  try {
    await writeFile(tempPath, bytes);
    return await extractPdfTextWithPdftotext(tempPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ── DOCX ──────────────────────────────────────────────────────────────────────

// ── Public API ────────────────────────────────────────────────────────────────

export function supportsPromptTextExtraction(input: {
  readonly mimeType: string;
  readonly fileName: string;
}): boolean {
  const mimeType = input.mimeType.toLowerCase();
  const fileName = input.fileName.toLowerCase();
  return (
    isTextReadable(mimeType) ||
    isTextReadableFileName(fileName) ||
    mimeType === PDF_MIME_TYPE ||
    mimeType === DOCX_MIME_TYPE ||
    mimeType === PPTX_MIME_TYPE ||
    mimeType === XLSX_MIME_TYPE ||
    supportsOcrTextExtraction({ mimeType, fileName }) ||
    fileName.endsWith(".pdf") ||
    fileName.endsWith(".docx") ||
    fileName.endsWith(".pptx") ||
    fileName.endsWith(".xlsx")
  );
}

export async function extractPromptTextFromBuffer(input: {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName: string;
}): Promise<string | null> {
  const mimeType = input.mimeType.toLowerCase();
  const fileName = input.fileName.toLowerCase();

  if (isTextReadable(mimeType) || isTextReadableFileName(fileName)) {
    const text = normalizeExtractedText(new TextDecoder().decode(input.bytes));
    return text.length > 0 ? truncateExtractedText(text) : null;
  }

  if (mimeType === PDF_MIME_TYPE || fileName.endsWith(".pdf")) {
    const text = await extractPdfTextFromBuffer(input.bytes);
    if (text !== null) return truncateExtractedText(text);

    const ocrText = await extractOcrTextFromBuffer(input);
    return ocrText !== null ? truncateExtractedText(ocrText) : null;
  }

  if (mimeType === DOCX_MIME_TYPE || fileName.endsWith(".docx")) {
    const text = extractDocxTextFromBuffer(input.bytes);
    return text.length > 0 ? truncateExtractedText(text) : null;
  }

  if (mimeType === PPTX_MIME_TYPE || fileName.endsWith(".pptx")) {
    const text = extractPptxTextFromBuffer(input.bytes);
    return text.length > 0 ? truncateExtractedText(text) : null;
  }

  if (mimeType === XLSX_MIME_TYPE || fileName.endsWith(".xlsx")) {
    const text = extractXlsxTextFromBuffer(input.bytes);
    return text.length > 0 ? truncateExtractedText(text) : null;
  }

  if (supportsOcrTextExtraction({ mimeType, fileName })) {
    const text = await extractOcrTextFromBuffer(input);
    return text !== null ? truncateExtractedText(text) : null;
  }

  return null;
}

export async function extractPromptTextFromFile(input: {
  readonly filePath: string;
  readonly mimeType: string;
  readonly fileName: string;
}): Promise<string | null> {
  const mimeType = input.mimeType.toLowerCase();
  const fileName = input.fileName.toLowerCase();

  if (isTextReadable(mimeType) || isTextReadableFileName(fileName)) {
    return normalizeExtractedText(await readFile(input.filePath, "utf8"));
  }

  if (mimeType === PDF_MIME_TYPE || fileName.endsWith(".pdf")) {
    const text = await extractPdfTextWithPdftotext(input.filePath);
    if (text !== null) return truncateExtractedText(text);

    const ocrText = await extractOcrTextFromFile(input);
    return ocrText !== null ? truncateExtractedText(ocrText) : null;
  }

  if (!supportsPromptTextExtraction({ mimeType, fileName })) return null;

  if (supportsOcrTextExtraction({ mimeType, fileName })) {
    const ocrText = await extractOcrTextFromFile(input);
    if (ocrText !== null) return truncateExtractedText(ocrText);
  }

  return extractPromptTextFromBuffer({
    bytes: await readFile(input.filePath),
    mimeType,
    fileName,
  });
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

export function formatAttachedImageOcrContents(
  blocks: ReadonlyArray<{ readonly fileName: string; readonly text: string }>,
): string {
  return `<attached_image_ocr>\n${blocks
    .map(
      (block) =>
        `<image name="${block.fileName}">\nOCR text extracted from this image. May contain errors.\n${block.text}\n</image>`,
    )
    .join("\n")}\n</attached_image_ocr>`;
}

export function appendAttachedImageOcrContents(
  prompt: string,
  blocks: ReadonlyArray<{ readonly fileName: string; readonly text: string }>,
): string {
  if (blocks.length === 0) return prompt;
  const attachedImageOcr = formatAttachedImageOcrContents(blocks);
  return prompt.length > 0 ? `${prompt}\n\n${attachedImageOcr}` : attachedImageOcr;
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

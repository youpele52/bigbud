import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

import { normalizeExtractedText } from "./documentText.shared.ts";

const execFileAsync = promisify(execFile);

const OCR_IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const OCR_IMAGE_MIME_TYPES = new Set([
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

function inferOcrTempExtension(input: {
  readonly mimeType: string;
  readonly fileName: string;
}): string {
  const fromFileName = extname(input.fileName.toLowerCase());
  if (OCR_IMAGE_EXTENSIONS.has(fromFileName) || fromFileName === ".pdf") {
    return fromFileName;
  }
  if (input.mimeType === "application/pdf") return ".pdf";
  if (input.mimeType === "image/jpeg" || input.mimeType === "image/jpg") return ".jpg";
  if (input.mimeType === "image/tiff") return ".tiff";
  if (input.mimeType === "image/webp") return ".webp";
  return ".png";
}

async function runTesseract(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tesseract", [filePath, "stdout"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    const text = normalizeExtractedText(stdout);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function renderPdfPagesToPngs(filePath: string, outputBase: string): Promise<string[]> {
  try {
    await execFileAsync("pdftoppm", ["-png", "-f", "1", "-l", "3", filePath, outputBase], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch {
    return [];
  }

  const directory = dirname(outputBase);
  const baseName = basename(outputBase);
  const files = await readdir(directory);
  return files
    .filter((file) => file.startsWith(`${baseName}-`) && file.endsWith(".png"))
    .toSorted((left, right) => left.localeCompare(right))
    .map((file) => join(directory, file));
}

async function extractPdfOcrTextFromFile(filePath: string): Promise<string | null> {
  const tempDir = await mkdtemp(join(tmpdir(), "bigbud-pdf-ocr-"));
  try {
    const pages = await renderPdfPagesToPngs(filePath, join(tempDir, "page"));
    if (pages.length === 0) return null;

    const pageTexts: string[] = [];
    for (const pagePath of pages) {
      const text = await runTesseract(pagePath);
      if (text) pageTexts.push(text);
    }

    const combined = normalizeExtractedText(pageTexts.join("\n\n"));
    return combined.length > 0 ? combined : null;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function supportsOcrTextExtraction(input: {
  readonly mimeType: string;
  readonly fileName: string;
}): boolean {
  const mimeType = input.mimeType.toLowerCase();
  const fileName = input.fileName.toLowerCase();
  return (
    mimeType === "application/pdf" ||
    OCR_IMAGE_MIME_TYPES.has(mimeType) ||
    fileName.endsWith(".pdf") ||
    Array.from(OCR_IMAGE_EXTENSIONS).some((extension) => fileName.endsWith(extension))
  );
}

export async function extractOcrTextFromFile(input: {
  readonly filePath: string;
  readonly mimeType: string;
  readonly fileName: string;
}): Promise<string | null> {
  const mimeType = input.mimeType.toLowerCase();
  const fileName = input.fileName.toLowerCase();
  if (mimeType === "application/pdf" || fileName.endsWith(".pdf")) {
    return extractPdfOcrTextFromFile(input.filePath);
  }
  return runTesseract(input.filePath);
}

export async function extractOcrTextFromBuffer(input: {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName: string;
}): Promise<string | null> {
  const tempDir = await mkdtemp(join(tmpdir(), "bigbud-ocr-buffer-"));
  const tempPath = join(
    tempDir,
    `document${inferOcrTempExtension({
      mimeType: input.mimeType.toLowerCase(),
      fileName: input.fileName,
    })}`,
  );
  try {
    await writeFile(tempPath, input.bytes);
    return extractOcrTextFromFile({
      filePath: tempPath,
      mimeType: input.mimeType,
      fileName: input.fileName,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

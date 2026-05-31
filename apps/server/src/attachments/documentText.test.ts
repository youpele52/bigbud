import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendAttachedImageOcrContents,
  appendUnextractableFileNotice,
  extractDocxTextFromBuffer,
  extractPromptTextFromBuffer,
  extractPromptTextFromFile,
} from "./documentText.ts";

function makeZipWithStoredEntry(fileName: string, content: string): Buffer {
  return makeZipWithStoredEntries([[fileName, content]]);
}

function makeZipWithStoredEntries(entries: ReadonlyArray<readonly [string, string]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [fileName, content] of entries) {
    const fileNameBytes = Buffer.from(fileName, "utf8");
    const contentBytes = Buffer.from(content, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(contentBytes.length, 18);
    localHeader.writeUInt32LE(contentBytes.length, 22);
    localHeader.writeUInt16LE(fileNameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralDirectory = Buffer.alloc(46);
    centralDirectory.writeUInt32LE(0x02014b50, 0);
    centralDirectory.writeUInt16LE(20, 4);
    centralDirectory.writeUInt16LE(20, 6);
    centralDirectory.writeUInt16LE(0, 8);
    centralDirectory.writeUInt16LE(0, 10);
    centralDirectory.writeUInt32LE(0, 12);
    centralDirectory.writeUInt32LE(0, 16);
    centralDirectory.writeUInt32LE(contentBytes.length, 20);
    centralDirectory.writeUInt32LE(contentBytes.length, 24);
    centralDirectory.writeUInt16LE(fileNameBytes.length, 28);
    centralDirectory.writeUInt16LE(0, 30);
    centralDirectory.writeUInt16LE(0, 32);
    centralDirectory.writeUInt16LE(0, 34);
    centralDirectory.writeUInt16LE(0, 36);
    centralDirectory.writeUInt32LE(0, 38);
    centralDirectory.writeUInt32LE(offset, 42);

    localParts.push(localHeader, fileNameBytes, contentBytes);
    centralParts.push(centralDirectory, fileNameBytes);
    offset += localHeader.length + fileNameBytes.length + contentBytes.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((size, part) => size + part.length, 0);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectorySize, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endOfCentralDirectory]);
}

function makeSimplePdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length + 31} >>\nstream\nBT\n/F1 12 Tf\n72 720 Td\n(${text}) Tj\nET\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref
0 ${objects.length + 1}
0000000000 65535 f
`;

  for (const offset of offsets.slice(1)) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n
`;
  }

  pdf += `trailer
<< /Root 1 0 R /Size ${objects.length + 1} >>
startxref
${xrefOffset}
%%EOF`;

  return Buffer.from(pdf, "latin1");
}

describe("documentText", () => {
  it("extracts paragraph text from DOCX document XML", () => {
    const docx = makeZipWithStoredEntry(
      "word/document.xml",
      "<w:document><w:body><w:p><w:r><w:t>First paragraph</w:t></w:r></w:p><w:p><w:r><w:t>Second &amp; final</w:t></w:r></w:p></w:body></w:document>",
    );

    expect(extractDocxTextFromBuffer(docx)).toBe("First paragraph\nSecond & final");
  });

  it("extracts text from PPTX slides", async () => {
    const pptx = makeZipWithStoredEntries([
      [
        "ppt/slides/slide1.xml",
        "<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Quarterly update</a:t></a:r></a:p><a:p><a:r><a:t>Revenue up</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
      ],
      [
        "ppt/slides/slide2.xml",
        "<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Next steps</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
      ],
    ]);

    const result = await extractPromptTextFromBuffer({
      bytes: pptx,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileName: "deck.pptx",
    });

    expect(result).toContain("Slide 1");
    expect(result).toContain("Quarterly update");
    expect(result).toContain("Next steps");
  });

  it("extracts text from XLSX sheets", async () => {
    const xlsx = makeZipWithStoredEntries([
      [
        "xl/workbook.xml",
        '<workbook><sheets><sheet name="Summary"/><sheet name="Notes"/></sheets></workbook>',
      ],
      [
        "xl/sharedStrings.xml",
        "<sst><si><t>Revenue</t></si><si><t>Growth</t></si><si><t>Stable</t></si></sst>",
      ],
      [
        "xl/worksheets/sheet1.xml",
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c></row></sheetData></worksheet>',
      ],
      [
        "xl/worksheets/sheet2.xml",
        '<worksheet><sheetData><row><c t="s"><v>2</v></c></row></sheetData></worksheet>',
      ],
    ]);

    const result = await extractPromptTextFromBuffer({
      bytes: xlsx,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName: "sheet.xlsx",
    });

    expect(result).toContain("Summary");
    expect(result).toContain("Revenue\t42");
    expect(result).toContain("Notes");
    expect(result).toContain("Stable");
  });

  it("formats unreadable attachment notices with a no-tool-read instruction", () => {
    expect(
      appendUnextractableFileNotice("summarize this", [
        { fileName: "scan.pdf", mimeType: "application/pdf" },
      ]),
    ).toContain("Do not call file-reading tools on this attachment path");
  });

  it("formats OCR text for image attachments in a dedicated block", () => {
    const result = appendAttachedImageOcrContents("summarize this screenshot", [
      { fileName: "screenshot.png", text: "fatal: not a git repository" },
    ]);

    expect(result).toContain("<attached_image_ocr>");
    expect(result).toContain('<image name="screenshot.png">');
    expect(result).toContain("OCR text extracted from this image. May contain errors.");
    expect(result).toContain("fatal: not a git repository");
  });

  it("extracts text from a PDF via pdftotext when available", async () => {
    // Skip on systems where pdftotext (Poppler) is not installed.
    try {
      execSync("pdftotext -v", { stdio: "ignore" });
    } catch {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "documentText-test-"));
    try {
      const pdfPath = join(dir, "simple.pdf");
      writeFileSync(pdfPath, makeSimplePdf("pdftotext works"));

      const result = await extractPromptTextFromFile({
        filePath: pdfPath,
        mimeType: "application/pdf",
        fileName: "test.pdf",
      });

      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThan(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts UTF-8 text documents from in-memory buffers", async () => {
    const result = await extractPromptTextFromBuffer({
      bytes: new TextEncoder().encode("hello\nworld"),
      mimeType: "text/plain",
      fileName: "notes.txt",
    });

    expect(result).toBe("hello\nworld");
  });

  it("falls back to OCR for image documents when local OCR tools are available", async () => {
    try {
      execSync("tesseract --version", { stdio: "ignore" });
      execSync("convert --version", { stdio: "ignore" });
    } catch {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "documentText-ocr-image-"));
    try {
      execSync(
        `convert -size 900x220 -background white -fill black -gravity center -pointsize 72 label:${JSON.stringify("OCR SAMPLE")} ${JSON.stringify(join(dir, "sample.png"))}`,
        { stdio: "ignore" },
      );

      const result = await extractPromptTextFromFile({
        filePath: join(dir, "sample.png"),
        mimeType: "image/png",
        fileName: "sample.png",
      });

      expect(result).toMatch(/OCR|SAMPLE/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to OCR for scanned PDFs when local OCR tools are available", async () => {
    try {
      execSync("tesseract --version", { stdio: "ignore" });
      execSync("convert --version", { stdio: "ignore" });
    } catch {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "documentText-ocr-pdf-"));
    try {
      execSync(
        `convert -size 1100x240 -background white -fill black -gravity center -pointsize 72 label:${JSON.stringify("SCANNED PDF")} ${JSON.stringify(join(dir, "scan.png"))}`,
        { stdio: "ignore" },
      );
      try {
        execSync(
          `convert ${JSON.stringify(join(dir, "scan.png"))} ${JSON.stringify(join(dir, "scan.pdf"))}`,
          { stdio: "ignore" },
        );
      } catch {
        return;
      }

      const result = await extractPromptTextFromFile({
        filePath: join(dir, "scan.pdf"),
        mimeType: "application/pdf",
        fileName: "scan.pdf",
      });

      expect(result).toMatch(/SCANNED|PDF/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

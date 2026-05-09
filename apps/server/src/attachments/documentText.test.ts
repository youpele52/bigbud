import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendUnextractableFileNotice,
  extractDocxTextFromBuffer,
  extractPromptTextFromFile,
} from "./documentText.ts";

function makeZipWithStoredEntry(fileName: string, content: string): Buffer {
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

  const centralDirectoryOffset = localHeader.length + fileNameBytes.length + contentBytes.length;
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
  centralDirectory.writeUInt32LE(0, 42);

  const centralDirectorySize = centralDirectory.length + fileNameBytes.length;
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(1, 8);
  endOfCentralDirectory.writeUInt16LE(1, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectorySize, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([
    localHeader,
    fileNameBytes,
    contentBytes,
    centralDirectory,
    fileNameBytes,
    endOfCentralDirectory,
  ]);
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

  it("formats unreadable attachment notices with a no-tool-read instruction", () => {
    expect(
      appendUnextractableFileNotice("summarize this", [
        { fileName: "scan.pdf", mimeType: "application/pdf" },
      ]),
    ).toContain("Do not call file-reading tools on this attachment path");
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
});

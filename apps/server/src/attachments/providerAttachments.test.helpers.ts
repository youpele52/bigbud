import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveAttachmentPath } from "./attachmentStore.ts";

/** Small managed fixtures shared by adapter delivery tests; source provenance is intentionally unreadable. */
export function writeProviderAttachmentFixtures(attachmentsDir: string) {
  const text = "immutable document context";
  const imageBytes = readFileSync(
    new URL("../../../web/public/favicon-16x16.png", import.meta.url),
  );
  const pdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Length 32 >>\nstream\nBT (PDF document context) Tj ET\nendstream\nendobj\n%%EOF",
  );
  const document = {
    type: "file",
    id: "document",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(text),
    sourcePath: "/never/read/source",
  } as const;
  const image = {
    type: "image",
    id: "image",
    name: "diagram.png",
    mimeType: "image/png",
    sizeBytes: imageBytes.length,
  } as const;
  const pdf = {
    type: "file",
    id: "pdf",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: pdfBytes.length,
  } as const;
  mkdirSync(attachmentsDir, { recursive: true });
  for (const [attachment, bytes] of [
    [document, Buffer.from(text)],
    [image, imageBytes],
    [pdf, pdfBytes],
  ] as const) {
    const filename = resolveAttachmentPath({ attachment, attachmentsDir })!;
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, bytes);
  }
  return { document, image, pdf, text, imageBytes, pdfBytes };
}

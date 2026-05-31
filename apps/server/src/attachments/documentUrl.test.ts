import { execSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { readPromptTextFromUrl } from "./documentUrl.ts";

function makeSimplePdf(text: string): Uint8Array {
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

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

describe("documentUrl", () => {
  it("extracts readable text from a generic HTML page", async () => {
    const result = await readPromptTextFromUrl({
      url: "https://example.com/report",
      fetchImpl: async () =>
        new Response(
          "<html><head><title>Report</title></head><body><main><h1>Status</h1><p>Everything works.</p></main></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Report");
    expect(result?.text).toContain("Status");
    expect(result?.text).toContain("Everything works.");
  });

  it("resolves arXiv abstract URLs to the PDF extractor path", async () => {
    try {
      execSync("pdftotext -v", { stdio: "ignore" });
    } catch {
      return;
    }

    let fetchedUrl = "";
    const pdfBytes = makeSimplePdf("Arxiv paper body");

    const result = await readPromptTextFromUrl({
      url: "https://arxiv.org/abs/1234.56789",
      fetchImpl: async (input) => {
        fetchedUrl = String(input);
        return new Response(pdfBytes, {
          headers: { "content-type": "application/pdf" },
        });
      },
    });

    expect(fetchedUrl).toBe("https://arxiv.org/pdf/1234.56789.pdf");
    expect(result?.resolvedUrl).toBe("https://arxiv.org/pdf/1234.56789.pdf");
    expect(result?.text).toContain("Arxiv paper body");
  });

  it("resolves IACR paper URLs to the PDF extractor path", async () => {
    try {
      execSync("pdftotext -v", { stdio: "ignore" });
    } catch {
      return;
    }

    let fetchedUrl = "";
    const pdfBytes = makeSimplePdf("IACR appendix");

    const result = await readPromptTextFromUrl({
      url: "https://eprint.iacr.org/2024/123",
      fetchImpl: async (input) => {
        fetchedUrl = String(input);
        return new Response(pdfBytes, { headers: { "content-type": "application/pdf" } });
      },
    });

    expect(fetchedUrl).toBe("https://eprint.iacr.org/2024/123.pdf");
    expect(result?.resolvedUrl).toBe("https://eprint.iacr.org/2024/123.pdf");
    expect(result?.text).toContain("IACR appendix");
  });

  it("extracts remote text files from binary responses using the response filename", async () => {
    const result = await readPromptTextFromUrl({
      url: "https://example.com/download",
      fetchImpl: async () =>
        new Response(new TextEncoder().encode("remote text body"), {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="notes.txt"',
          },
        }),
    });

    expect(result?.resolvedUrl).toBe("https://example.com/download");
    expect(result?.text).toBe("remote text body");
  });
});

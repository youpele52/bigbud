import { expect, it } from "vitest";
import { extractHtmlDocument } from "./documentUrl.html.ts";

it("keeps text after quoted attributes and ignores comments and raw markup", async () => {
  const source = `<!doctype html><title>Reports &amp; results &#x2014; October</title>
    <!-- internal editorial note > draft -->
    <script>const example = '<section>example</section>'; if (1 < 2) example;</script>
    <style>.note { color: blue }</style>
    <p data-label="value > threshold < 10" title='nested "quotation"'>Progress &lt; 10</p>
    <section data-note=it's-ready>Next steps &amp; owners</section>`;
  const result = await extractHtmlDocument(source, "fallback.example");
  expect(result.title).toBe("Reports & results — October");
  expect(result.text).toMatch(/^Progress < 10\s+Next steps & owners$/);
});

it("bounds the rendered preview and handles an unterminated raw-text section", async () => {
  const result = await extractHtmlDocument(
    `<p>${"a".repeat(40_000)}</p><style>draft`,
    "fallback.example",
  );
  expect(result.text).toBe(`${"a".repeat(32_000)}\n\n[Document text truncated]`);
  expect(result.title).toBe("fallback.example");
  const partial = await extractHtmlDocument(
    "<p>Visible text</p><script>not visible",
    "fallback.example",
  );
  expect(partial.text).toBe("Visible text");
});

it("observes cancellation during HTML extraction", async () => {
  const controller = new AbortController();
  const extracting = extractHtmlDocument("<p>Report</p>", "fallback.example", controller.signal);
  controller.abort();
  await expect(extracting).rejects.toThrow();
});

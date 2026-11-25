import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { readPromptTextFromUrl } from "./documentUrl.ts";
import { MAX_DOCUMENT_DOWNLOAD_BYTES } from "./documentUrl.download.ts";
import { isPublicDocumentAddress } from "./documentUrl.policy.ts";
import { documentTransport } from "./documentUrl.test.fixture.ts";

const url = "https://example.com/start";

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function textResponse(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/plain" } });
}

function addresses(address: string) {
  return [{ address }];
}

const stalledResolution = () => new Promise<never>(() => {});
const dualStack = async () => [{ address: "93.184.216.34" }, { address: "2606:4700::1111" }];

describe("document URL destination policy", () => {
  it.each(["not a URL", "file:///sample.txt", "https://user@example.com/doc"])(
    "rejects invalid or unsupported input before networking (%s)",
    async (input) => {
      const respond = vi.fn(() => textResponse("unused"));
      const resolve = vi.fn(async () => addresses("93.184.216.34"));
      await expect(
        readPromptTextFromUrl({ url: input, transport: documentTransport(respond, resolve) }),
      ).rejects.toThrow(/HTTP or HTTPS/);
      expect(respond).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("classifies globally routable and non-public address fixtures", () => {
    expect(["93.184.216.34", "2606:4700::1111"].map(isPublicDocumentAddress)).toEqual([true, true]);
    expect(
      [
        "127.0.0.1",
        "10.0.0.1",
        "100.64.0.1",
        "169.254.0.1",
        "192.0.2.1",
        "239.0.0.1",
        "::1",
        "::ffff:192.0.2.1",
        "fe80::1",
        "fd00::1",
        "2001:db8::1",
        "ff02::1",
      ].some(isPublicDocumentAddress),
    ).toBe(false);
  });

  it("pins each hop to its vetted IP while retaining the correct host and TLS identity", async () => {
    const resolve = vi.fn(async (host: string) =>
      addresses(host === "example.com" ? "93.184.216.34" : "2606:4700::1111"),
    );
    const fixture = documentTransport(
      (target) =>
        target === url ? redirect("https://www.example.org/report.txt") : textResponse("Report"),
      resolve,
    );
    const open = vi.fn(fixture.open);
    await expect(
      readPromptTextFromUrl({ url, transport: { resolve, open } }),
    ).resolves.toMatchObject({
      sourceUrl: url,
      resolvedUrl: "https://www.example.org/report.txt",
      text: "Report",
    });
    expect(resolve.mock.calls).toEqual([["example.com"], ["www.example.org"]]);
    expect(open).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        hostname: "93.184.216.34",
        servername: "example.com",
        agent: false,
        rejectUnauthorized: true,
        headers: expect.objectContaining({ host: "example.com" }),
      }),
    );
    expect(open).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        hostname: "2606:4700::1111",
        servername: "www.example.org",
        path: "/report.txt",
      }),
    );
  });

  it("falls back to a vetted address of another family and preserves TLS identity", async () => {
    const resolve = vi.fn(async () => [
      { address: "2606:4700::1111" },
      { address: "2606:4700::1001" },
      { address: "93.184.216.34" },
    ]);
    const fixture = documentTransport(() => textResponse("Report"), resolve);
    const open = vi.fn(fixture.open).mockRejectedValueOnce(new Error("first address unavailable"));
    await expect(
      readPromptTextFromUrl({ url, transport: { resolve, open } }),
    ).resolves.toMatchObject({ text: "Report" });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("example.com");
    expect(open.mock.calls.map(([options]) => [options.hostname, options.servername])).toEqual([
      ["2606:4700::1111", "example.com"],
      ["93.184.216.34", "example.com"],
    ]);
  });

  it("bounds address attempts even when a hostname has more vetted answers", async () => {
    const resolve = vi.fn(async () =>
      [93, 94, 95, 96, 97].map((first) => ({ address: `${first}.184.216.34` })),
    );
    const fixture = documentTransport(() => textResponse("unused"), resolve);
    const open = vi.fn(fixture.open).mockRejectedValue(new Error("address unavailable"));
    await expect(readPromptTextFromUrl({ url, transport: { resolve, open } })).rejects.toThrow(
      "Could not download the document",
    );
    expect(resolve).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(4);
  });

  it("cancels an in-flight body and does not open a second address", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let notify!: () => void;
    const reading = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const resolve = dualStack;
    const fixture = documentTransport(
      () => new Response(new ReadableStream<Uint8Array>({ pull: notify, cancel })),
      resolve,
    );
    const open = vi.fn(fixture.open);
    const pending = readPromptTextFromUrl({
      url,
      signal: controller.signal,
      transport: { resolve, open },
    });
    const rejected = expect(pending).rejects.toThrow("download was cancelled");
    await reading;
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  });

  it("rejects a redirect when any DNS answer is not public", async () => {
    const respond = vi.fn(() => redirect("https://www.example.org/report.txt"));
    const resolve = async (host: string) =>
      host === "example.com"
        ? addresses("93.184.216.34")
        : [...addresses("93.184.216.34"), ...addresses("192.0.2.1")];
    await expect(
      readPromptTextFromUrl({ url, transport: documentTransport(respond, resolve) }),
    ).rejects.toThrow("Only public document URLs are allowed");
    expect(respond).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("bounds redirects and disallows HTTPS downgrades", async () => {
    const repeated = vi.fn(() => redirect("/next"));
    await expect(
      readPromptTextFromUrl({ url, transport: documentTransport(repeated) }),
    ).rejects.toThrow("Too many redirects");
    expect(repeated).toHaveBeenCalledTimes(6);
    const downgrade = vi.fn(() => redirect("http://example.org/report"));
    await expect(
      readPromptTextFromUrl({ url, transport: documentTransport(downgrade) }),
    ).rejects.toThrow("redirected to an insecure URL");
    expect(downgrade).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("times out DNS before opening a connection", async () => {
    const respond = vi.fn(() => textResponse("unused"));
    await expect(
      readPromptTextFromUrl({
        url,
        transport: documentTransport(respond, stalledResolution),
        timeoutMs: 10,
      }),
    ).rejects.toThrow("download timed out");
    expect(respond).not.toHaveBeenCalled();
  });
});

describe("document URL body limits", () => {
  it.each(["text/html", "application/pdf", "application/octet-stream"])(
    "stops an oversized %s stream even without a content length and disposes it",
    async (mime) => {
      const chunk = new Uint8Array(MAX_DOCUMENT_DOWNLOAD_BYTES / 2);
      const cancel = vi.fn();
      let pulls = 0;
      const transport = documentTransport(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulls += 1;
                controller.enqueue(chunk);
              },
              cancel,
            }),
            { headers: { "content-type": mime } },
          ),
      );
      await expect(readPromptTextFromUrl({ url, transport })).rejects.toThrow(
        "10 MB download limit",
      );
      expect(pulls).toBeLessThan(6);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("disposes a stalled body on timeout", async () => {
    const cancel = vi.fn();
    const transport = documentTransport(
      () => new Response(new ReadableStream<Uint8Array>({ cancel })),
    );
    await expect(readPromptTextFromUrl({ url, transport, timeoutMs: 10 })).rejects.toThrow(
      "download timed out",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reads gzip text and enforces the same limits on decoded bytes", async () => {
    const gzipResponse = (buffer: Buffer) =>
      new Response(new Uint8Array(gzipSync(buffer)), {
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
      });
    await expect(
      readPromptTextFromUrl({
        url,
        transport: documentTransport(() => gzipResponse(Buffer.from("Report"))),
      }),
    ).resolves.toMatchObject({ text: "Report" });
    await expect(
      readPromptTextFromUrl({
        url,
        transport: documentTransport(() =>
          gzipResponse(Buffer.alloc(MAX_DOCUMENT_DOWNLOAD_BYTES + 1, "x")),
        ),
      }),
    ).rejects.toThrow("10 MB download limit");
  });

  it("marks extracted text truncation without exceeding the document text budget", async () => {
    const text = "a".repeat(40_000);
    const transport = documentTransport(() => textResponse(text));
    const result = await readPromptTextFromUrl({ url, transport });
    expect(result.text).toBe(`${text.slice(0, 32_000)}\n\n[Document text truncated]`);
  });
});

import { describe, expect, it, vi } from "vitest";
import { CodexModelPages, listCodexModels } from "./codexAppServer.models.pagination.ts";

describe("Codex complete model catalogs", () => {
  it("requests all catalog pages before returning an authoritative result", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "one" }], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [{ id: "two" }], nextCursor: null });
    const models = await listCodexModels(request);
    expect(models.map((model) => model.slug)).toEqual(["one", "two"]);
    expect(request.mock.calls.map(([params]) => params)).toEqual([
      { cursor: null, limit: 100 },
      { cursor: "next", limit: 100 },
    ]);
  });

  it("rejects duplicate models rather than silently replacing capabilities", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "one" }], nextCursor: "next" })
      .mockResolvedValueOnce({
        data: [{ id: "one", serviceTiers: [{ id: "fast" }] }],
        nextCursor: null,
      });
    await expect(listCodexModels(request)).rejects.toThrow("duplicate model");
  });

  it("rejects repeated cursors even with different model records", () => {
    const pages = new CodexModelPages();
    pages.append({ data: [{ id: "one" }], nextCursor: "same" });
    expect(() => pages.append({ data: [{ id: "two" }], nextCursor: "same" })).toThrow(
      "no progress",
    );
  });
});

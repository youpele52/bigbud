import { describe, expect, it, vi } from "vitest";

vi.mock("~/rpc/nativeApi", () => ({ ensureNativeApi: vi.fn() }));

import { ensureNativeApi } from "~/rpc/nativeApi";
import { conversationSearchQueryOptions } from "./conversationSearchQuery";

describe("conversation search query", () => {
  it("requests bounded server pages with the returned cursor", async () => {
    const searchConversationMessages = vi.fn().mockResolvedValue({
      status: "ready",
      projectionSequence: 10,
      hits: [],
      nextCursor: 42,
    });
    vi.mocked(ensureNativeApi).mockReturnValue({
      orchestration: { searchConversationMessages },
    } as unknown as ReturnType<typeof ensureNativeApi>);

    const options = conversationSearchQueryOptions({ query: "DeepSeek", enabled: true });
    expect(options.enabled).toBe(true);
    const first = await options.queryFn!({ pageParam: undefined } as never);
    expect(searchConversationMessages).toHaveBeenCalledWith({ query: "DeepSeek", limit: 30 });
    expect(options.getNextPageParam(first, [first], undefined, [undefined])).toBe(42);
    await options.queryFn!({ pageParam: 42 } as never);
    expect(searchConversationMessages).toHaveBeenLastCalledWith({
      query: "DeepSeek",
      limit: 30,
      cursor: 42,
    });
    expect(conversationSearchQueryOptions({ query: "ab", enabled: true }).enabled).toBe(false);
    expect(conversationSearchQueryOptions({ query: "😀a", enabled: true }).enabled).toBe(false);
    expect(conversationSearchQueryOptions({ query: "😀ab", enabled: true }).enabled).toBe(true);
    expect(conversationSearchQueryOptions({ query: "İ".repeat(160), enabled: true }).enabled).toBe(
      true,
    );
    expect(conversationSearchQueryOptions({ query: "a".repeat(160), enabled: true }).enabled).toBe(
      true,
    );
    expect(conversationSearchQueryOptions({ query: "a".repeat(161), enabled: true }).enabled).toBe(
      false,
    );
  });
});

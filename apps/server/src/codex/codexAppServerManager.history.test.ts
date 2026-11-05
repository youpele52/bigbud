import { describe, expect, it, vi } from "vitest";
import { readCodexThreadHistory } from "./codexAppServerManager.history.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";

function harness() {
  const context = {
    session: { resumeCursor: { threadId: "native" }, sessionEpoch: 2 },
    runtimeVersion: "0.166.0",
    historyGeneration: 0,
    stopping: false,
  } as unknown as CodexSessionContext;
  const sendRequest = vi
    .fn()
    .mockResolvedValueOnce({ thread: { id: "native", historyMode: "paginated" } });
  return { context, sendRequest };
}
const turn = (id = "t1", items: unknown[] = []) => ({ id, items, itemsView: "full" });

describe("Codex complete history reads", () => {
  it("uses metadata only followed by ascending full-detail turn pages", async () => {
    const { context, sendRequest } = harness();
    sendRequest.mockResolvedValueOnce({ data: [turn()], nextCursor: "next" });
    sendRequest.mockResolvedValueOnce({ data: [turn("t2")], nextCursor: null });
    const result = await readCodexThreadHistory(context, { sendRequest });
    expect(result.turns.map((value) => value.id)).toEqual(["t1", "t2"]);
    expect(sendRequest.mock.calls[0]?.slice(1, 3)).toEqual([
      "thread/read",
      { threadId: "native", includeTurns: false },
    ]);
    expect(sendRequest.mock.calls[1]?.slice(1, 3)).toEqual([
      "thread/turns/list",
      {
        threadId: "native",
        cursor: null,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
      },
    ]);
  });

  it("hydrates summary items with an explicit turn and ascending order", async () => {
    const { context, sendRequest } = harness();
    sendRequest.mockResolvedValueOnce({
      data: [{ ...turn(), itemsView: "summary" }],
      nextCursor: null,
    });
    sendRequest.mockResolvedValueOnce({
      data: [{ turnId: "t1", item: { id: "i1", type: "agentMessage" } }],
      nextCursor: null,
    });
    const result = await readCodexThreadHistory(context, { sendRequest });
    expect(result.turns[0]?.items).toEqual([{ id: "i1", type: "agentMessage" }]);
    expect(sendRequest.mock.calls[2]?.[2]).toEqual({
      threadId: "native",
      turnId: "t1",
      cursor: null,
      limit: 100,
      sortDirection: "asc",
    });
  });

  it.each([
    { data: [turn(), turn()], nextCursor: null },
    { data: [{ items: [] }], nextCursor: null },
    { data: [], nextCursor: "next" },
    { data: [turn()], nextCursor: 1 },
    { data: [turn()], nextCursor: null, second: true },
  ])("rejects incomplete, corrupt, or duplicate history: %j", async (page) => {
    const { context, sendRequest } = harness();
    if (page.second) {
      sendRequest.mockResolvedValueOnce({ data: [turn()], nextCursor: "next" });
      sendRequest.mockResolvedValueOnce({ data: [turn("t2")], nextCursor: "next" });
    } else sendRequest.mockResolvedValueOnce(page);
    await expect(readCodexThreadHistory(context, { sendRequest })).rejects.toThrow();
  });

  it("rejects a wrong thread before returning any turns", async () => {
    const { context, sendRequest } = harness();
    sendRequest
      .mockReset()
      .mockResolvedValueOnce({ thread: { id: "other", historyMode: "paginated" } });
    await expect(readCodexThreadHistory(context, { sendRequest })).rejects.toThrow(
      "different thread",
    );
  });

  it("rejects item hydration from a different turn", async () => {
    const { context, sendRequest } = harness();
    sendRequest.mockResolvedValueOnce({
      data: [{ ...turn(), itemsView: "summary" }],
      nextCursor: null,
    });
    sendRequest.mockResolvedValueOnce({
      data: [{ turnId: "other", item: { id: "i1" } }],
      nextCursor: null,
    });
    await expect(readCodexThreadHistory(context, { sendRequest })).rejects.toThrow(
      "different turn",
    );
  });

  it("discards a read invalidated during an async request", async () => {
    const { context, sendRequest } = harness();
    sendRequest.mockImplementationOnce(async () => {
      context.historyGeneration = 1;
      return { data: [turn()], nextCursor: null };
    });
    await expect(readCodexThreadHistory(context, { sendRequest })).rejects.toThrow(
      "stale snapshot",
    );
  });

  it("fails closed for an unqualified version without probing mutations", async () => {
    const { context, sendRequest } = harness();
    context.runtimeVersion = "0.167.0";
    await expect(readCodexThreadHistory(context, { sendRequest })).rejects.toThrow("unqualified");
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("enforces the aggregate record budget including full items", async () => {
    const { context, sendRequest } = harness();
    sendRequest.mockResolvedValueOnce({ data: [turn("t1", [{ id: "i1" }])], nextCursor: null });
    await expect(
      readCodexThreadHistory(
        context,
        { sendRequest },
        {
          pages: 10,
          records: 1,
          bytes: 100_000,
          timeoutMs: 1000,
        },
      ),
    ).rejects.toThrow("record budget");
  });

  it("uses only real IDs in the qualified legacy lane", async () => {
    const { context, sendRequest } = harness();
    context.runtimeVersion = "0.100.0";
    sendRequest
      .mockReset()
      .mockResolvedValueOnce({ thread: { id: "native", turns: [{ items: [] }] } });
    await expect(readCodexThreadHistory(context, { sendRequest })).rejects.toThrow("turn id");
  });
});

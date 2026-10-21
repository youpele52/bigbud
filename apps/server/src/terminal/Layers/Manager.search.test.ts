import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { TerminalSearchIndex, type SearchableTerminal } from "./Manager.search";
import { createManager, openInput, waitFor } from "./Manager.test.helpers";

const terminal = (overrides: Partial<SearchableTerminal>): SearchableTerminal => ({
  threadId: "thread-1",
  terminalId: "default",
  status: "running",
  history: "",
  updatedAt: "2026-10-21T10:00:00.000Z",
  ...overrides,
});

describe("TerminalSearchIndex", () => {
  it("finds displayed text case-insensitively, newest line first, without escape sequences", () => {
    const index = new TerminalSearchIndex();
    const result = index.search(
      [
        terminal({
          history:
            "$ npm test\r\n\x1b[31mFAIL\x1b[0m src/a.test.ts\r\nbuilding\r\x1b[2Kbuild failed: Missing token\r\n$ ",
        }),
      ],
      { query: "fail" },
    );
    expect(result.truncated).toBe(false);
    expect(result.hits.map((hit) => [hit.lineText, hit.matchStart, hit.linesFromEnd])).toEqual([
      ["build failed: Missing token", 6, 1],
      ["FAIL src/a.test.ts", 0, 2],
    ]);
  });

  it("ignores queries outside the shared length bounds", () => {
    const index = new TerminalSearchIndex();
    const sessions = [terminal({ history: "ab abc" })];
    expect(index.search(sessions, { query: " ab " }).hits).toEqual([]);
    expect(index.search(sessions, { query: "x".repeat(161) }).hits).toEqual([]);
  });

  it("orders running terminals first, dedupes repeated redraws and reports truncation", () => {
    const index = new TerminalSearchIndex();
    const result = index.search(
      [
        terminal({ terminalId: "old", status: "exited", history: "match one\r\n" }),
        terminal({
          terminalId: "live",
          updatedAt: "2026-10-21T09:00:00.000Z",
          history: "match spinner\r\nmatch spinner\r\nmatch two\r\n",
        }),
      ],
      { query: "match", limit: 2 },
    );
    expect(result.hits.map((hit) => [hit.terminalId, hit.lineText, hit.running])).toEqual([
      ["live", "match two", true],
      ["live", "match spinner", true],
    ]);
    expect(result.truncated).toBe(true);
  });

  it("clips long lines around the match and keeps the offset pointing at it", () => {
    const index = new TerminalSearchIndex();
    const line = `${"a".repeat(500)}NEEDLE${"b".repeat(500)}`;
    const [hit] = index.search([terminal({ history: line })], { query: "needle" }).hits;
    expect(hit!.lineText.startsWith("…")).toBe(true);
    expect(hit!.lineText.endsWith("…")).toBe(true);
    expect(hit!.lineText.slice(hit!.matchStart, hit!.matchStart + 6)).toBe("NEEDLE");
  });

  it("rebuilds a terminal's lines only after its history changed", () => {
    const index = new TerminalSearchIndex();
    const session = terminal({ history: "first value\r\n" });
    expect(index.search([session], { query: "value" }).hits).toHaveLength(1);
    expect(
      index.search([{ ...session, history: `${session.history}second value\r\n` }], {
        query: "value",
      }).hits,
    ).toHaveLength(2);
    // A terminal that closed disappears from results.
    expect(index.search([], { query: "value" }).hits).toEqual([]);
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager search", (it) => {
  it.effect("searches the output retained by live terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      ptyAdapter.processes[0]?.emitData("\x1b[32mServer listening\x1b[0m on port 5173\r\n");
      yield* waitFor(
        manager.search!({ query: "listening" }).pipe(
          Effect.map((result) => result.hits.length === 1),
        ),
      );
      const result = yield* manager.search!({ query: "PORT 5173" });
      expect(result.hits).toEqual([
        expect.objectContaining({
          threadId: "thread-1",
          terminalId: "default",
          lineText: "Server listening on port 5173",
          running: true,
        }),
      ]);
    }),
  );
});

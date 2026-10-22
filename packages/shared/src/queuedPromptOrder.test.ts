import { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import { insertQueuedPrompt } from "./queuedPromptOrder";

const prompt = (id: string, alreadySent?: boolean) => ({
  id: MessageId.makeUnsafe(id),
  text: id,
  createdAt: "2026-10-22T00:00:00.000Z",
  ...(alreadySent ? { alreadySent } : {}),
});
const ids = (prompts: ReadonlyArray<{ readonly id: string }>) => prompts.map(({ id }) => id);

describe("insertQueuedPrompt", () => {
  it("appends ordinary prompts whatever their position", () => {
    expect(ids(insertQueuedPrompt([prompt("a")], prompt("b"), 1))).toEqual(["a", "b"]);
  });

  it("places a redelivery at its decided position", () => {
    expect(ids(insertQueuedPrompt([prompt("c")], prompt("ab", true), 1))).toEqual(["ab", "c"]);
  });

  it("appends a redelivery from an event without a position", () => {
    expect(ids(insertQueuedPrompt([prompt("c")], prompt("ab", true), undefined))).toEqual([
      "c",
      "ab",
    ]);
  });
});

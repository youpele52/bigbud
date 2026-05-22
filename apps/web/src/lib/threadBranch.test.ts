import { describe, expect, it } from "vitest";

import {
  MAX_SEED_MESSAGES,
  prepareSeedMessages,
  prepareSeedMessagesForBranch,
  sliceMessagesForBranch,
  ThreadBranchError,
  type SeedMessageInput,
} from "./threadBranch";

function message(
  id: string,
  role: SeedMessageInput["role"],
  overrides?: Partial<SeedMessageInput>,
): SeedMessageInput {
  return {
    id,
    role,
    text: `${role}-${id}`,
    streaming: false,
    createdAt: `2026-01-01T00:00:${id.replace(/\D/g, "").padStart(2, "0").slice(-2)}.000Z`,
    ...overrides,
  };
}

describe("sliceMessagesForBranch", () => {
  const messages = [
    message("m1", "user"),
    message("m2", "assistant"),
    message("m3", "user"),
    message("m4", "assistant"),
  ];

  it("returns an inclusive prefix through the branch point", () => {
    expect(sliceMessagesForBranch(messages, "m3" as never).map((entry) => entry.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  it("throws when the branch point message is missing", () => {
    expect(() => sliceMessagesForBranch(messages, "missing" as never)).toThrow(ThreadBranchError);
  });

  it("throws when the branch point message is still streaming", () => {
    const streaming = [message("m1", "user"), message("m2", "assistant", { streaming: true })];
    expect(() => sliceMessagesForBranch(streaming, "m2" as never)).toThrow(
      /Wait for the message to finish/,
    );
  });
});

describe("prepareSeedMessagesForBranch", () => {
  it("matches a full-thread branch when no branch point is provided", () => {
    const messages = [message("m1", "user"), message("m2", "assistant")];
    expect(prepareSeedMessagesForBranch(messages)).toHaveLength(2);
    expect(prepareSeedMessages(messages)).toHaveLength(2);
  });

  it("seeds only through the branch point message", () => {
    const messages = [
      message("m1", "user"),
      message("m2", "assistant"),
      message("m3", "user"),
      message("m4", "assistant"),
    ];
    const seeded = prepareSeedMessagesForBranch(messages, { upToMessageId: "m2" as never });
    expect(seeded).toHaveLength(2);
    expect(seeded[0]?.role).toBe("user");
    expect(seeded[1]?.role).toBe("assistant");
    expect(seeded[0]?.text).toBe("user-m1");
    expect(seeded[1]?.text).toBe("assistant-m2");
  });

  it("caps long prefixes while keeping the branch point", () => {
    const messages = Array.from({ length: MAX_SEED_MESSAGES + 5 }, (_, index) =>
      message(`m${index}`, index % 2 === 0 ? "user" : "assistant"),
    );
    const branchPointId = messages.at(-1)?.id;
    expect(branchPointId).toBeDefined();

    const seeded = prepareSeedMessagesForBranch(messages, {
      upToMessageId: branchPointId as never,
    });
    expect(seeded).toHaveLength(MAX_SEED_MESSAGES);
    expect(seeded.at(-1)?.text).toBe(
      messages.at(-1)?.role === "user" ? `user-${branchPointId}` : `assistant-${branchPointId}`,
    );
  });

  it("returns an empty array when given an empty message list", () => {
    expect(prepareSeedMessagesForBranch([])).toHaveLength(0);
  });

  it("throws ThreadBranchError when the branch point is not in the list", () => {
    const messages = [message("m1", "user"), message("m2", "assistant")];
    expect(() =>
      prepareSeedMessagesForBranch(messages, { upToMessageId: "nonexistent" as never }),
    ).toThrow(ThreadBranchError);
  });
});

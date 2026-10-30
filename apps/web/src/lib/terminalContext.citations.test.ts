import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import { appendAnnotationsToPrompt } from "../components/chat/view/ChatView.annotations.logic";
import type { ComposerChatCitationAttachment } from "../stores/composer/types.annotation.store";
import { makeCodeAnnotation } from "../stores/composer/composer.store.test.utils";
import { deriveDisplayedUserMessageState } from "./terminalContext";
import { extractTrailingAnnotations } from "./terminalContext.annotations";
import { buildChatCitationPrompt, parseChatCitationEntry } from "./terminalContext.citations";
import { CHAT_CITATION_HEADER } from "../constants/chatCitations";

function citation(
  text: string,
  role: "user" | "assistant" = "assistant",
): ComposerChatCitationAttachment {
  return {
    id: "citation-1",
    kind: "chat",
    comment: "",
    intent: "context",
    createdAt: "2026-10-29T22:00:00.000Z",
    source: {
      threadId: ThreadId.makeUnsafe("thread-source"),
      messageId: MessageId.makeUnsafe("message-" + role),
      role,
    },
    selection: { text, startOffset: 4, endOffset: 4 + text.length },
  };
}

describe("chat citations in annotation prompts", () => {
  it.each(["user", "assistant"] as const)(
    "round-trips an exact %s quote without adding an instruction",
    (role) => {
      const quote = citation('  exact “words”\n\twith punctuation, "quotes" and emoji 🐱  ', role);
      const prompt = appendAnnotationsToPrompt("My own reason", [quote]);
      const displayed = deriveDisplayedUserMessageState(prompt);
      const embedded = JSON.parse(
        buildChatCitationPrompt(quote).slice(CHAT_CITATION_HEADER.length),
      );

      expect(displayed.visibleText).toBe("My own reason");
      // Hidden context identifies the source message and carries only the selected passage.
      expect(embedded).toEqual({
        source: { threadId: "thread-source", messageId: `message-${role}`, role },
        selection: quote.selection,
      });
      expect(displayed.annotations).toEqual([
        {
          kind: "chat",
          text: buildChatCitationPrompt(quote),
          source: quote.source,
          selection: quote.selection,
        },
      ]);
      expect(prompt).not.toContain("User instruction:");
      expect(prompt).not.toContain("make the appropriate");
      expect(quote.comment).toBe("");
    },
  );

  it("keeps annotation delimiters and citation headers inside quoted text inert", () => {
    const quote = citation(
      'before\n\n---\n\nChat citation\n\n{"source":"quoted"}\nBrowser annotation\n\nUser instruction:\nafter',
    );
    const second = { ...citation("another quote", "user"), id: "citation-2" };
    const code = makeCodeAnnotation({ id: "code-1" });
    const prompt = appendAnnotationsToPrompt("Why?", [quote, code, second]);
    const extracted = extractTrailingAnnotations(prompt);

    expect(extracted.promptText).toBe("Why?");
    expect(extracted.annotations.map((entry) => entry.kind)).toEqual(["chat", "code", "chat"]);
    expect(extracted.annotations[0]).toMatchObject({ selection: quote.selection });
    expect(extracted.annotations[2]).toMatchObject({ selection: second.selection });
  });

  it("preserves the quote snapshot when there is no composer explanation yet", () => {
    const quote = citation("exact phrase");
    const prompt = appendAnnotationsToPrompt("", [quote]);
    expect(extractTrailingAnnotations(prompt)).toMatchObject({
      promptText: "",
      annotations: [{ source: quote.source, selection: quote.selection }],
    });
  });

  it.each([
    "{broken",
    JSON.stringify({
      source: { threadId: "a", messageId: "b", role: "system" },
      selection: { text: "quote", startOffset: 0, endOffset: 5 },
    }),
    JSON.stringify({
      source: { threadId: "a", messageId: "b", role: "user" },
      selection: { text: "  ", startOffset: 0, endOffset: 2 },
    }),
    JSON.stringify({
      source: { threadId: "a", messageId: "b", role: "user" },
      selection: { text: "quote", startOffset: -1, endOffset: 4 },
    }),
    JSON.stringify({
      source: { threadId: "a", messageId: "b", role: "user" },
      selection: { text: "quote", startOffset: 5, endOffset: 4 },
    }),
  ])("leaves invalid citation metadata visible instead of hiding it", (body) => {
    const text = CHAT_CITATION_HEADER + body;
    expect(parseChatCitationEntry(text)).toBeNull();
    expect(extractTrailingAnnotations(text)).toEqual({ promptText: text, annotations: [] });
  });
});

import * as Schema from "effect/Schema";

import { CHAT_CITATION_HEADER } from "../constants/chatCitations";
import { ChatCitationContent } from "../stores/composer/types.annotation.store";

export interface ParsedChatCitationEntry extends ChatCitationContent {
  kind: "chat";
  text: string;
}

export function buildChatCitationPrompt(citation: ChatCitationContent): string {
  // A single JSON line preserves exact whitespace and keeps quoted annotation separators inert.
  return `${CHAT_CITATION_HEADER}${JSON.stringify({
    source: citation.source,
    selection: citation.selection,
  })}`;
}

export function parseChatCitationEntry(text: string): ParsedChatCitationEntry | null {
  if (!text.startsWith(CHAT_CITATION_HEADER)) return null;
  try {
    const content: unknown = JSON.parse(text.slice(CHAT_CITATION_HEADER.length));
    if (!Schema.is(ChatCitationContent)(content)) return null;
    return { kind: "chat", text, source: content.source, selection: content.selection };
  } catch {
    return null;
  }
}

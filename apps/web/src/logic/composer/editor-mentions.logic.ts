import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "../../lib/terminalContext";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      rawValue: string;
      displayLabel: string;
      mentionKind: "path" | "agent" | "skill";
    }
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    };

interface SplitPromptIntoComposerSegmentsOptions {
  readonly allowTrailingAgentAndSkillMentions?: boolean;
}

const MENTION_TOKEN_REGEX = /(^|\s)@([^\s@]+)(?=\s|$)/g;

function rangeIncludesIndex(start: number, end: number, index: number): boolean {
  return start <= index && index < end;
}

function parseMentionToken(rawValue: string): {
  rawValue: string;
  displayLabel: string;
  mentionKind: "path" | "agent" | "skill";
} {
  if (rawValue.startsWith("agent:") || rawValue.startsWith("agent::")) {
    const displayLabel = rawValue.replace(/^agent::?/, "");
    return {
      rawValue,
      displayLabel,
      mentionKind: "agent",
    };
  }
  if (rawValue.startsWith("skill:") || rawValue.startsWith("skill::")) {
    const displayLabel = rawValue.replace(/^skill::?/, "");
    return {
      rawValue,
      displayLabel,
      mentionKind: "skill",
    };
  }
  const pathSegments = rawValue.split(/[\\/]/);
  return {
    rawValue,
    displayLabel: pathSegments[pathSegments.length - 1] ?? rawValue,
    mentionKind: "path",
  };
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function forEachPromptSegmentSlice(
  prompt: string,
  visitor: (
    slice:
      | {
          type: "text";
          text: string;
          promptOffset: number;
        }
      | {
          type: "terminal-context";
          promptOffset: number;
        },
  ) => boolean | void,
): boolean {
  let textCursor = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (
      index > textCursor &&
      visitor({
        type: "text",
        text: prompt.slice(textCursor, index),
        promptOffset: textCursor,
      }) === true
    ) {
      return true;
    }

    if (visitor({ type: "terminal-context", promptOffset: index }) === true) {
      return true;
    }

    textCursor = index + 1;
  }

  if (
    textCursor < prompt.length &&
    visitor({
      type: "text",
      text: prompt.slice(textCursor),
      promptOffset: textCursor,
    }) === true
  ) {
    return true;
  }

  return false;
}

function forEachPromptTextSlice(
  prompt: string,
  visitor: (text: string, promptOffset: number) => boolean | void,
): boolean {
  return forEachPromptSegmentSlice(prompt, (slice) => {
    if (slice.type !== "text") {
      return false;
    }

    return visitor(slice.text, slice.promptOffset);
  });
}

function forEachMentionMatch(
  prompt: string,
  visitor: (match: RegExpMatchArray, promptOffset: number) => boolean | void,
): boolean {
  return forEachPromptTextSlice(prompt, (text, promptOffset) => {
    for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
      if (visitor(match, promptOffset) === true) {
        return true;
      }
    }

    return false;
  });
}

function shouldKeepTrailingMentionAsText(
  mention: Extract<ComposerPromptSegment, { type: "mention" }>,
  options: SplitPromptIntoComposerSegmentsOptions,
): boolean {
  if (mention.mentionKind === "path") {
    return true;
  }
  return !options.allowTrailingAgentAndSkillMentions;
}

function splitPromptTextIntoComposerSegments(
  text: string,
  options: SplitPromptIntoComposerSegmentsOptions,
): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  let cursor = 0;
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const rawValue = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const mentionStart = matchIndex + prefix.length;
    const mentionEnd = mentionStart + fullMatch.length - prefix.length;

    if (mentionStart > cursor) {
      pushTextSegment(segments, text.slice(cursor, mentionStart));
    }

    if (rawValue.length > 0) {
      const mention = { type: "mention" as const, ...parseMentionToken(rawValue) };
      if (mentionEnd === text.length && shouldKeepTrailingMentionAsText(mention, options)) {
        pushTextSegment(segments, text.slice(mentionStart, mentionEnd));
      } else {
        segments.push(mention);
      }
    } else {
      pushTextSegment(segments, text.slice(mentionStart, mentionEnd));
    }

    cursor = mentionEnd;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
  options: SplitPromptIntoComposerSegmentsOptions = {},
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const segments: ComposerPromptSegment[] = [];
  let terminalContextIndex = 0;

  forEachPromptSegmentSlice(prompt, (slice) => {
    if (slice.type === "text") {
      segments.push(...splitPromptTextIntoComposerSegments(slice.text, options));
      return false;
    }

    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextIndex] ?? null,
    });
    terminalContextIndex += 1;
    return false;
  });

  return segments;
}

export function selectionTouchesMentionBoundary(
  prompt: string,
  start: number,
  end: number,
): boolean {
  if (!prompt || start >= end) {
    return false;
  }

  return forEachMentionMatch(prompt, (match, promptOffset) => {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const matchIndex = match.index ?? 0;
    const mentionStart = promptOffset + matchIndex + prefix.length;
    const mentionEnd = mentionStart + fullMatch.length - prefix.length;
    const beforeMentionIndex = mentionStart - 1;
    const afterMentionIndex = mentionEnd;

    if (
      beforeMentionIndex >= 0 &&
      /\s/.test(prompt[beforeMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, beforeMentionIndex)
    ) {
      return true;
    }

    if (
      afterMentionIndex < prompt.length &&
      /\s/.test(prompt[afterMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, afterMentionIndex)
    ) {
      return true;
    }

    return false;
  });
}

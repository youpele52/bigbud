/**
 * Plain chat replies that decide a cross-project confirmation (Settled decision 3: "plain yes
 * reply"). Matching is on whole words of the normalized reply, so "now", "know", "note" and
 * "another" never read as "no" or "not". The code is optional and never part of the decision.
 *
 * @module ThreadCoordinationConfirmation.phrases
 */

/** A refusal anywhere denies, even after an approval ("yes, I mean no"). */
export const THREAD_COORDINATION_DENY_PHRASES = [
  "no",
  "nope",
  "not",
  "don't",
  "dont",
  "do not",
  "stop",
  "cancel",
  "deny",
  "never",
] as const;

/** A hedge anywhere leaves the reply undecided ("ok wait", "approve the PR first"). */
export const THREAD_COORDINATION_HEDGE_PHRASES = [
  "wait",
  "hold",
  "later",
  "first",
  "but",
  "actually",
  "instead",
  "maybe",
] as const;

/** Only a reply that starts with (or is) one of these approves. */
export const THREAD_COORDINATION_ALLOW_PHRASES = [
  "i approve",
  "go ahead",
  "approved",
  "confirmed",
  "approve",
  "confirm",
  "proceed",
  "do it",
  "allow",
  "okay",
  "sure",
  "yeah",
  "yep",
  "yes",
  "ok",
  "y",
] as const;

/** Part of every confirmation question; a reply that contains it is quoting the question back. */
const QUESTION_PREFIX = "allow this thread to";

const CODE_PATTERN = /\bbb-[a-z2-7]{8}\b/g;

export type ThreadCoordinationReplyVerdict = "allowed" | "denied" | "none";

/** Lowercase, straight apostrophes, single spaces, trimmed. */
export function normalizeConfirmationReply(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whole words, without surrounding quote marks ("'no'" is "no", "don't" stays "don't"). */
const wordsOf = (text: string): ReadonlyArray<string> =>
  (text.match(/[\p{L}\p{N}']+/gu) ?? [])
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter((word) => word.length > 0);

const phraseWords = (phrase: string) => phrase.split(" ");

const containsPhrase = (words: ReadonlyArray<string>, phrase: string) => {
  const target = phraseWords(phrase);
  return words.some((_, start) => target.every((word, offset) => words[start + offset] === word));
};

const startsWithPhrase = (words: ReadonlyArray<string>, phrase: string) =>
  phraseWords(phrase).every((word, offset) => words[offset] === word);

/**
 * Classifies one user-typed reply to a confirmation question, in this order:
 * 1. Empty, or ending in `?`: never decisive.
 * 2. A refusal word anywhere (outside a quoted question): Deny.
 * 3. A hedge word anywhere, or the question quoted back: not decisive.
 * 4. Starts with or equals an approval phrase: Allow. Anything else is not decisive.
 */
export function classifyConfirmationReply(
  text: string,
  options: { readonly question?: string | undefined } = {},
): ThreadCoordinationReplyVerdict {
  const reply = normalizeConfirmationReply(text);
  if (reply.length === 0 || reply.endsWith("?")) return "none";
  const question = options.question ? normalizeConfirmationReply(options.question) : "";
  const quotesQuestion =
    reply.includes(QUESTION_PREFIX) || (question.length > 0 && reply.includes(question));
  // A quoted question is the agent's words, so its project title cannot inject a refusal.
  const ownWords = question.length > 0 ? reply.split(question).join(" ") : reply;
  const words = wordsOf(ownWords.replace(CODE_PATTERN, " "));
  if (THREAD_COORDINATION_DENY_PHRASES.some((phrase) => containsPhrase(words, phrase))) {
    return "denied";
  }
  if (
    quotesQuestion ||
    THREAD_COORDINATION_HEDGE_PHRASES.some((phrase) => containsPhrase(words, phrase))
  ) {
    return "none";
  }
  return THREAD_COORDINATION_ALLOW_PHRASES.some((phrase) => startsWithPhrase(words, phrase))
    ? "allowed"
    : "none";
}

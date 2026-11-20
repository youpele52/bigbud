import { GREETING_MESSAGES, type GreetingMessage, type GreetingPeriod } from "./greeting.messages";

const LOCAL_WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Bucket the device's local hour, including the night period across midnight. */
export function getGreetingPeriod(now: Date): GreetingPeriod {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/** Check day restrictions against the device's local calendar day. */
export function isGreetingEligibleOnLocalDate(message: GreetingMessage, now: Date): boolean {
  if (!message.eligibleDays) return true;
  const weekday = LOCAL_WEEKDAYS[now.getDay()];
  return weekday !== undefined && message.eligibleDays.includes(weekday);
}

/** Keep the logo-only outcome independent of the 60/40 time-aware copy weighting. */
export function selectGreeting({
  now,
  random,
  previousId,
}: {
  now: Date;
  random: () => number;
  previousId?: string | undefined;
}): GreetingMessage | null {
  if (random() < 0.1) return null;
  const pool: ReadonlyArray<GreetingMessage> =
    random() < 0.6 ? GREETING_MESSAGES[getGreetingPeriod(now)] : GREETING_MESSAGES.anytime;
  const candidates = pool.filter(
    (message) => message.id !== previousId && isGreetingEligibleOnLocalDate(message, now),
  );
  return candidates[Math.floor(random() * candidates.length)] ?? candidates[0] ?? null;
}

/** Intentionally phrased unnamed copy avoids dangling punctuation or empty slots. */
export function renderGreeting(message: GreetingMessage | null, name: string): string | null {
  if (!message) return null;
  const trimmed = name.trim();
  const renderedName = trimmed || message.nameFallback;
  return renderedName && message.named
    ? message.named.replace("{name}", () => renderedName)
    : message.nameless;
}

/**
 * UI-only, page-lifetime choices keyed by draft/canonical thread identity.
 * The identity survives route remounts, model changes, and provider reconnects;
 * neither the choice nor its copy is written into the thread or sent to a provider.
 */
export function createGreetingSelector({
  now = () => new Date(),
  random = Math.random,
}: {
  now?: () => Date;
  random?: () => number;
} = {}) {
  const choices = new Map<string, GreetingMessage | null>();
  let previousId: string | undefined;
  return (identity: string): GreetingMessage | null => {
    if (!choices.has(identity)) {
      choices.set(identity, selectGreeting({ now: now(), random, previousId }));
    }
    const choice = choices.get(identity) ?? null;
    if (choice) previousId = choice.id;
    return choice;
  };
}

export const greetingForChat = createGreetingSelector();

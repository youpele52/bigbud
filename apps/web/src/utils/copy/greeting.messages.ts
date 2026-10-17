export type GreetingPeriod = "morning" | "afternoon" | "evening" | "night";
export type GreetingDay =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export interface GreetingMessage {
  readonly id: string;
  readonly nameless: string;
  readonly named?: string;
  readonly nameFallback?: string;
  readonly eligibleDays?: readonly GreetingDay[];
}

// All new-chat copy lives here. {name} is rendered as plain text, never markup.
// Entries without a named variant deliberately work the same way for everyone.
export const GREETING_MESSAGES = {
  morning: [
    {
      id: "morning-mind",
      nameless: "Good morning. What’s on your mind?",
      named: "Good morning, {name}. What’s on your mind?",
    },
    {
      id: "morning-build",
      nameless: "Morning. What shall we build?",
      named: "Morning, {name}. What shall we build?",
    },
    {
      id: "morning-idea",
      nameless: "A fresh morning, a fresh idea?",
      named: "A fresh morning, {name}. Got an idea?",
    },
    {
      id: "morning-explore",
      nameless: "Good morning. What would you like to explore?",
      named: "Good morning, {name}. What would you like to explore?",
    },
    {
      id: "morning-tinker",
      nameless: "A little morning tinkering?",
      named: "A little morning tinkering, {name}?",
    },
    { id: "morning-start", nameless: "A new morning. An open canvas." },
    {
      id: "source-good-morning",
      nameless: "Good morning, bud",
      named: "Good morning, {name}",
      nameFallback: "bud",
    },
    {
      id: "source-welcome-morning",
      nameless: "Welcome, bud",
      named: "Welcome, {name}",
      nameFallback: "bud",
    },
    {
      id: "source-hey-there",
      nameless: "Hey there, bud",
      named: "Hey there, {name}",
      nameFallback: "bud",
    },
    {
      id: "source-happy-monday",
      nameless: "Happy Monday, bud",
      named: "Happy Monday, {name}",
      nameFallback: "bud",
      eligibleDays: ["monday"],
    },
    {
      id: "source-happy-tuesday",
      nameless: "Happy Tuesday, bud",
      named: "Happy Tuesday, {name}",
      nameFallback: "bud",
      eligibleDays: ["tuesday"],
    },
    {
      id: "source-happy-wednesday",
      nameless: "Happy Wednesday, bud",
      named: "Happy Wednesday, {name}",
      nameFallback: "bud",
      eligibleDays: ["wednesday"],
    },
    {
      id: "source-happy-thursday",
      nameless: "Happy Thursday, bud",
      named: "Happy Thursday, {name}",
      nameFallback: "bud",
      eligibleDays: ["thursday"],
    },
    {
      id: "source-happy-friday",
      nameless: "Happy Friday, bud",
      named: "Happy Friday, {name}",
      nameFallback: "bud",
      eligibleDays: ["friday"],
    },
    {
      id: "source-friday-feeling",
      nameless: "That Friday feeling, bud",
      named: "That Friday feeling, {name}",
      nameFallback: "bud",
      eligibleDays: ["friday"],
    },
    {
      id: "source-weekend-welcome",
      nameless: "Welcome to the weekend, bud",
      named: "Welcome to the weekend, {name}",
      nameFallback: "bud",
      eligibleDays: ["saturday", "sunday"],
    },
    {
      id: "source-happy-saturday",
      nameless: "Happy Saturday, bud",
      named: "Happy Saturday, {name}",
      nameFallback: "bud",
      eligibleDays: ["saturday"],
    },
    {
      id: "source-weekend-mind",
      nameless: "What’s on your mind, bud?",
      named: "What’s on your mind, {name}?",
      nameFallback: "bud",
      eligibleDays: ["saturday", "sunday"],
    },
    {
      id: "source-sunday-session",
      nameless: "Sunday session, bud?",
      named: "Sunday session, {name}?",
      nameFallback: "bud",
      eligibleDays: ["sunday"],
    },
    {
      id: "source-happy-sunday",
      nameless: "Happy Sunday, bud",
      named: "Happy Sunday, {name}",
      nameFallback: "bud",
      eligibleDays: ["sunday"],
    },
    { id: "source-coffee", nameless: "Coffee and bigbud time?" },
  ],
  afternoon: [
    {
      id: "afternoon-next",
      nameless: "Good afternoon. What’s next?",
      named: "Good afternoon, {name}. What’s next?",
    },
    {
      id: "afternoon-mind",
      nameless: "Afternoon. What’s on your mind?",
      named: "Afternoon, {name}. What’s on your mind?",
    },
    {
      id: "afternoon-make",
      nameless: "What shall we make this afternoon?",
      named: "What shall we make this afternoon, {name}?",
    },
    {
      id: "afternoon-untangle",
      nameless: "Anything to untangle this afternoon?",
      named: "Anything to untangle this afternoon, {name}?",
    },
    {
      id: "afternoon-idea",
      nameless: "An afternoon idea taking shape?",
      named: "An afternoon idea taking shape, {name}?",
    },
    { id: "afternoon-room", nameless: "An afternoon with room for a new idea." },
    {
      id: "source-good-afternoon",
      nameless: "Good afternoon, bud",
      named: "Good afternoon, {name}",
      nameFallback: "bud",
    },
    {
      id: "source-how-are-you",
      nameless: "Hi bud, how are you?",
      named: "Hi {name}, how are you?",
      nameFallback: "bud",
    },
    {
      id: "source-whats-new",
      nameless: "What’s new, bud?",
      named: "What’s new, {name}?",
      nameFallback: "bud",
    },
    {
      id: "source-back-at-it",
      nameless: "Back at it, bud",
      named: "Back at it, {name}",
      nameFallback: "bud",
    },
  ],
  evening: [
    {
      id: "evening-working",
      nameless: "Evening. What are we working on?",
      named: "Evening, {name}. What are we working on?",
    },
    {
      id: "evening-mind",
      nameless: "Good evening. What’s on your mind?",
      named: "Good evening, {name}. What’s on your mind?",
    },
    {
      id: "evening-build",
      nameless: "What shall we build this evening?",
      named: "What shall we build this evening, {name}?",
    },
    {
      id: "evening-follow",
      nameless: "An idea to follow this evening?",
      named: "An idea to follow this evening, {name}?",
    },
    {
      id: "evening-explore",
      nameless: "Evening. What would you like to explore?",
      named: "Evening, {name}. What would you like to explore?",
    },
    { id: "evening-canvas", nameless: "An evening. A blank canvas. A new possibility." },
    {
      id: "source-returns",
      nameless: "bud returns!",
      named: "{name} returns!",
      nameFallback: "bud",
    },
    {
      id: "source-good-evening",
      nameless: "Good evening, bud",
      named: "Good evening, {name}",
      nameFallback: "bud",
    },
    {
      id: "source-evening",
      nameless: "Evening, bud",
      named: "Evening, {name}",
      nameFallback: "bud",
    },
    {
      id: "source-how-was-your-day",
      nameless: "How was your day, bud?",
      named: "How was your day, {name}?",
      nameFallback: "bud",
    },
  ],
  night: [
    { id: "night-idea", nameless: "A late-night idea?", named: "A late-night idea, {name}?" },
    { id: "night-jam", nameless: "It’s a late-night jam session." },
    {
      id: "night-mind",
      nameless: "What’s on your mind tonight, bud?",
      named: "What’s on your mind tonight, {name}?",
      nameFallback: "bud",
    },
    {
      id: "night-tinker",
      nameless: "A little late-night tinkering?",
      named: "A little late-night tinkering, {name}?",
    },
    {
      id: "night-follow",
      nameless: "Which idea are we following tonight?",
      named: "Which idea are we following tonight, {name}?",
    },
    { id: "night-thought", nameless: "A quiet hour for a curious thought." },
    {
      id: "source-how-is-it-going",
      nameless: "How’s it going, bud?",
      named: "How’s it going, {name}?",
      nameFallback: "bud",
    },
    { id: "source-night-owl", nameless: "Hello, night owl" },
  ],
  anytime: [
    { id: "anytime-next", nameless: "What’s up next?", named: "What’s up next, {name}?" },
    { id: "anytime-mind", nameless: "What’s on your mind?", named: "What’s on your mind, {name}?" },
    {
      id: "anytime-build",
      nameless: "What shall we build?",
      named: "What shall we build, {name}?",
    },
    {
      id: "anytime-start",
      nameless: "Where shall we start?",
      named: "Where shall we start, {name}?",
    },
    {
      id: "anytime-curious",
      nameless: "What are you curious about?",
      named: "What are you curious about, {name}?",
    },
    {
      id: "anytime-spark",
      nameless: "Got a spark of an idea?",
      named: "Got a spark of an idea, {name}?",
    },
    {
      id: "anytime-untangle",
      nameless: "What shall we untangle?",
      named: "What shall we untangle, {name}?",
    },
    {
      id: "anytime-make",
      nameless: "Let’s make something interesting.",
      named: "Let’s make something interesting, {name}.",
    },
    {
      id: "anytime-explore",
      nameless: "What would you like to explore?",
      named: "What would you like to explore, {name}?",
    },
    {
      id: "anytime-working",
      nameless: "What are we working on?",
      named: "What are we working on, {name}?",
    },
    { id: "anytime-small", nameless: "Big idea or small question? Both welcome." },
    { id: "anytime-canvas", nameless: "A blank canvas for whatever’s next." },
  ],
} as const satisfies Record<GreetingPeriod | "anytime", ReadonlyArray<GreetingMessage>>;

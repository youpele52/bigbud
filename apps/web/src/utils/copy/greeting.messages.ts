export type GreetingPeriod = "morning" | "afternoon" | "evening" | "night";

export interface GreetingMessage {
  readonly id: string;
  readonly nameless: string;
  readonly named?: string;
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
  ],
  night: [
    { id: "night-idea", nameless: "A late-night idea?", named: "A late-night idea, {name}?" },
    { id: "night-jam", nameless: "It’s a late-night jam session." },
    {
      id: "night-mind",
      nameless: "What’s on your mind tonight?",
      named: "What’s on your mind tonight, {name}?",
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

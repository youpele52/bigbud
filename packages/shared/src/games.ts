/** Curated destinations are independent of website metadata and redirects. */
export const GAMES = [
  {
    name: "PAC-MAN",
    url: "https://www.google.com/logos/2010/pacman10-i.html",
    category: "Arcade",
    description: "Play the classic PAC-MAN maze.",
  },
  {
    name: "Snake",
    url: "https://playsnake.org/",
    category: "Arcade",
    description: "Guide the snake and collect food.",
  },
  {
    name: "Tetris",
    url: "https://tetris.com/play-tetris",
    category: "Arcade",
    description: "Arrange falling blocks.",
  },
  {
    name: "Cookie Clicker",
    url: "https://orteil.dashnet.org/cookieclicker/",
    category: "Idle & strategy",
    description: "Bake cookies and build an empire.",
  },
  {
    name: "Universal Paperclips",
    url: "https://www.decisionproblem.com/paperclips/",
    category: "Idle & strategy",
    description: "Make paperclips and optimize production.",
  },
  {
    name: "A Dark Room",
    url: "https://adarkroom.doublespeakgames.com/",
    category: "Idle & strategy",
    description: "Explore a mysterious text adventure.",
  },
  {
    name: "Little Alchemy 2",
    url: "https://littlealchemy2.com/",
    category: "Creative",
    description: "Combine elements to discover new things.",
  },
  {
    name: "Infinite Craft",
    url: "https://neal.fun/infinite-craft/",
    category: "Creative",
    description: "Combine ideas to create anything.",
  },
  {
    name: "skribbl.io",
    url: "https://skribbl.io/",
    category: "Social & puzzles",
    description: "Draw and guess with friends.",
  },
  {
    name: "Solitaire",
    url: "https://cardgames.io/solitaire/",
    category: "Social & puzzles",
    description: "Play a classic card game.",
  },
  {
    name: "Word Wipe",
    url: "https://www.crazygames.com/game/word-wipe",
    category: "Social & puzzles",
    description: "Find words and clear the board.",
  },
  {
    name: "Retro Games",
    url: "https://www.retrogames.cz/",
    category: "Retro Games",
    description: "Play classic retro games in your browser.",
  },
] as const;

export type Game = (typeof GAMES)[number];

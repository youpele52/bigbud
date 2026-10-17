export const checkpointFixtures = [
  {
    name: "partial-CSI",
    prefix: "\x1b[31",
    suffix: "mX",
    cursor: [
      [1, 0],
      [2, 0],
    ],
  },
  {
    name: "custom-tab-stops",
    prefix: "\x1b[3g\x1b[1;4H\x1bH\x1b[H",
    suffix: "\tX",
    cursor: [
      [4, 0],
      [9, 0],
    ],
  },
  {
    name: "saved-cursor",
    prefix: "\x1b[2;3H\x1b7\x1b[5;7H",
    suffix: "\x1b8Z",
    cursor: [
      [3, 1],
      [1, 0],
    ],
  },
  {
    name: "scroll-region",
    prefix: "A\r\nB\r\nC\r\nD\r\nE\r\nF\x1b[2;4r",
    suffix: "\x1b[4;1H\nX",
    cursor: [
      [1, 3],
      [1, 4],
    ],
  },
];

// Synthetic only: no user terminal payloads or credentials enter this harness.
export const continuationFixtures = [
  ...checkpointFixtures,
  { name: "partial-OSC", prefix: "\x1b]0;synth", suffix: "etic\x07X" },
  { name: "partial-DCS", prefix: "\x1bP$q", suffix: "m\x1b\\X" },
  {
    name: "alternate-wide-combining",
    prefix: "normal\x1b[?1049h😀é",
    suffix: "\r\nnext\x1b[?1049lX",
  },
  { name: "query", prefix: "\x1b[2;3H", suffix: "\x1b[6nX" },
];

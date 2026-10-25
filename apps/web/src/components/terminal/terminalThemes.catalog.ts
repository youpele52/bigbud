// Built-in terminal themes. Colours adapted from Orca's MIT-licensed catalog
// (https://github.com/stablyai/orca, src/shared/terminal-themes, Copyright (c) 2026 Lovecast Inc.),
// which itself follows Ghostty/upstream theme definitions. Catppuccin Macchiato and Frappe use the
// official Catppuccin palette with the same slot mapping as Catppuccin Mocha.
//
// Each entry is the theme name and 22 colours in TERMINAL_THEME_SLOTS order.
export const TERMINAL_THEME_SLOTS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionForeground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export const TERMINAL_THEME_PALETTES: ReadonlyArray<readonly [name: string, colours: string]> = [
  [
    "Ayu Dark",
    "#0a0e14 #b3b1ad #e6b450 #0a0e14 #273747 #b3b1ad #01060e #ea6c73 #91b362 #f9af4f #53bdfa #fae994 #90e1c6 #c7c7c7 #686868 #f07178 #c2d94c #ffb454 #59c2ff #ffee99 #95e6cb #ffffff",
  ],
  [
    "Builtin Tango Light",
    "#ffffff #2e3434 #2e3434 #ffffff #accef7 #2e3434 #2e3436 #cc0000 #4e9a06 #8e7700 #3465a4 #75507b #05727e #6a6a6a #555753 #ef2929 #1b7a1b #6d5a00 #204a87 #ad7fa8 #034b50 #3d3d3d",
  ],
  [
    "Catppuccin Frappe",
    "#303446 #c6d0f5 #f2d5cf #303446 #626880 #c6d0f5 #51576d #e78284 #a6d189 #e5c890 #8caaee #f4b8e4 #81c8be #b5bfe2 #626880 #e78284 #a6d189 #e5c890 #8caaee #f4b8e4 #81c8be #a5adce",
  ],
  [
    "Catppuccin Latte",
    "#eff1f5 #4c4f69 #dc8a78 #eff1f5 #acb0be #4c4f69 #5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #bcc0cc",
  ],
  [
    "Catppuccin Macchiato",
    "#24273a #cad3f5 #f4dbd6 #24273a #5b6078 #cad3f5 #494d64 #ed8796 #a6da95 #eed49f #8aadf4 #f5bde6 #8bd5ca #b8c0e0 #5b6078 #ed8796 #a6da95 #eed49f #8aadf4 #f5bde6 #8bd5ca #a5adcb",
  ],
  [
    "Catppuccin Mocha",
    "#1e1e2e #cdd6f4 #f5e0dc #1e1e2e #585b70 #cdd6f4 #45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8",
  ],
  [
    "Dracula",
    "#282a36 #f8f8f2 #f8f8f2 #282a36 #44475a #f8f8f2 #21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff",
  ],
  [
    "Everforest Dark",
    "#2d353b #d3c6aa #d3c6aa #2d353b #543a48 #d3c6aa #475258 #e67e80 #a7c080 #dbbc7f #7fbbb3 #d699b6 #83c092 #d3c6aa #697379 #e67e80 #a7c080 #dbbc7f #7fbbb3 #d699b6 #83c092 #d3c6aa",
  ],
  [
    "Everforest Light",
    "#fdf6e3 #5c6a72 #5c6a72 #fdf6e3 #e6e2cc #5c6a72 #5c6a72 #f85552 #8da101 #dfa000 #3a94c5 #df69ba #35a77c #dfd9a8 #939f91 #f85552 #8da101 #dfa000 #3a94c5 #df69ba #35a77c #fdf6e3",
  ],
  [
    "Ghostty Default Style Dark",
    "#282c34 #ffffff #ffffff #282c34 #5a7898 #ffffff #1d1f21 #cc6666 #b5bd68 #f0c674 #81a2be #b294bb #8abeb7 #c5c8c6 #666666 #d54e53 #b9ca4a #e7c547 #7aa6da #c397d8 #70c0b1 #eaeaea",
  ],
  [
    "GitHub Light",
    "#ffffff #24292e #044289 #ffffff #c8c8fa #24292e #24292e #d73a49 #28a745 #dbab09 #0366d6 #5a32a3 #0598bc #6a737d #959da5 #cb2431 #22863a #b08800 #005cc5 #5a32a3 #3192aa #d1d5da",
  ],
  [
    "Gruvbox Dark",
    "#282828 #ebdbb2 #ebdbb2 #282828 #504945 #ebdbb2 #282828 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2",
  ],
  [
    "Gruvbox Light",
    "#fbf1c7 #3c3836 #3c3836 #fbf1c7 #ebdbb2 #3c3836 #fbf1c7 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #7c6f64 #928374 #9d0006 #79740e #b57614 #076678 #8f3f71 #427b58 #3c3836",
  ],
  [
    "Homebrew",
    "#000000 #00ff00 #00ff00 #000000 #005500 #00ff00 #000000 #990000 #00a600 #999900 #0000b2 #b200b2 #00a6b2 #bfbfbf #666666 #e50000 #00d900 #e5e500 #0000ff #e500e5 #00e5e5 #e5e5e5",
  ],
  [
    "Horizon Dark",
    "#1c1e26 #e0e0e0 #e95678 #1c1e26 #2e303e #e0e0e0 #16161c #e95678 #29d398 #fab795 #26bbd9 #ee64ac #59e1e3 #d5d8da #6c6f93 #ec6a88 #3fdaa4 #fbc3a7 #3fc4de #f075b5 #6be4e6 #f0f0f0",
  ],
  [
    "Kanagawa",
    "#1f1f28 #dcd7ba #c8c093 #1f1f28 #2d4f67 #dcd7ba #090618 #c34043 #76946a #c0a36e #7e9cd8 #957fb8 #6a9589 #c8c093 #727169 #e82424 #98bb6c #e6c384 #7fb4ca #938aa9 #7aa89f #dcd7ba",
  ],
  [
    "Material Dark",
    "#263238 #eeffff #ffcc00 #263238 #546e7a #eeffff #000000 #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #eeffff #546e7a #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #ffffff",
  ],
  [
    "Monokai",
    "#272822 #f8f8f2 #f8f8f0 #272822 #49483e #f8f8f2 #272822 #f92672 #a6e22e #f4bf75 #66d9ef #ae81ff #a1efe4 #f8f8f2 #75715e #f92672 #a6e22e #f4bf75 #66d9ef #ae81ff #a1efe4 #f9f8f5",
  ],
  [
    "Night Owl",
    "#011627 #d6deeb #80a4c2 #011627 #1d3b53 #d6deeb #011627 #ef5350 #22da6e #addb67 #82aaff #c792ea #21c7a8 #ffffff #575656 #ef5350 #22da6e #ffeb95 #82aaff #c792ea #7fdbca #ffffff",
  ],
  [
    "Nightfox",
    "#192330 #cdcecf #cdcecf #192330 #2b3b51 #cdcecf #393b44 #c94f6d #81b29a #dbc074 #719cd6 #9d79d6 #63cdcf #dfdfe0 #575860 #d16983 #8ebaa4 #e0c989 #86abdc #baa1e2 #7ad5d6 #e4e4e5",
  ],
  [
    "Nord",
    "#2e3440 #d8dee9 #d8dee9 #2e3440 #434c5e #d8dee9 #3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4",
  ],
  [
    "One Dark",
    "#282c34 #abb2bf #528bff #282c34 #3e4451 #abb2bf #282c34 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf #5c6370 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #ffffff",
  ],
  [
    "One Light",
    "#fafafa #383a42 #526fff #fafafa #e5e5e6 #383a42 #383a42 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #a0a1a7 #696c77 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #fafafa",
  ],
  [
    "Palenight",
    "#292d3e #a6accd #ffcc00 #292d3e #434758 #a6accd #292d3e #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #a6accd #676e95 #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #ffffff",
  ],
  [
    "Rose Pine",
    "#191724 #e0def4 #524f67 #e0def4 #403d52 #e0def4 #26233a #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4 #6e6a86 #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4",
  ],
  [
    "Rose Pine Dawn",
    "#faf4ed #575279 #9893a5 #faf4ed #dfdad9 #575279 #f2e9e1 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279 #9893a5 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279",
  ],
  [
    "Snazzy",
    "#282a36 #eff0eb #97979b #282a36 #3e404a #eff0eb #282a36 #ff5c57 #5af78e #f3f99d #57c7ff #ff6ac1 #9aedfe #f1f1f0 #686868 #ff5c57 #5af78e #f3f99d #57c7ff #ff6ac1 #9aedfe #f1f1f0",
  ],
  [
    "Solarized Dark",
    "#002b36 #839496 #839496 #002b36 #073642 #93a1a1 #073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #002b36 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3",
  ],
  [
    "Solarized Light",
    "#fdf6e3 #657b83 #657b83 #fdf6e3 #eee8d5 #586e75 #073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #002b36 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3",
  ],
  [
    "Tango Dark",
    "#000000 #d3d7cf #d3d7cf #000000 #555753 #eeeeec #2e3436 #cc0000 #4e9a06 #c4a000 #3465a4 #75507b #06989a #d3d7cf #555753 #ef2929 #8ae234 #fce94f #729fcf #ad7fa8 #34e2e2 #eeeeec",
  ],
  [
    "Tokyo Night",
    "#1a1b26 #c0caf5 #c0caf5 #1a1b26 #33467c #c0caf5 #15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5",
  ],
  [
    "Tokyo Night Light",
    "#d5d6db #343b58 #343b58 #d5d6db #9699a3 #343b58 #0f0f14 #8c4351 #485e30 #8f5e15 #34548a #5a4a78 #0f4b6e #343b58 #9699a3 #8c4351 #485e30 #8f5e15 #34548a #5a4a78 #0f4b6e #343b58",
  ],
];

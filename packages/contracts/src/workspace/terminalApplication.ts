import { Schema } from "effect";
import { TrimmedNonEmptyString } from "../core/baseSchemas";

type TerminalApplicationDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]];
  readonly cwdArgs: (cwd: string) => readonly string[];
};

export const TERMINAL_APPLICATIONS = [
  {
    id: "ghostty",
    label: "Ghostty",
    commands: ["ghostty"],
    cwdArgs: (cwd) => ["--working-directory", cwd],
  },
  {
    id: "wezterm",
    label: "WezTerm",
    commands: ["wezterm"],
    cwdArgs: (cwd) => ["start", "--cwd", cwd],
  },
  {
    id: "alacritty",
    label: "Alacritty",
    commands: ["alacritty"],
    cwdArgs: (cwd) => ["--working-directory", cwd],
  },
  { id: "kitty", label: "kitty", commands: ["kitty"], cwdArgs: (cwd) => ["--directory", cwd] },
  {
    id: "windows-terminal",
    label: "Windows Terminal",
    commands: ["wt"],
    cwdArgs: (cwd) => ["-d", cwd],
  },
  {
    id: "gnome-terminal",
    label: "GNOME Terminal",
    commands: ["gnome-terminal"],
    cwdArgs: (cwd) => [`--working-directory=${cwd}`],
  },
  { id: "konsole", label: "Konsole", commands: ["konsole"], cwdArgs: (cwd) => ["--workdir", cwd] },
  {
    id: "xfce4-terminal",
    label: "XFCE Terminal",
    commands: ["xfce4-terminal"],
    cwdArgs: (cwd) => [`--working-directory=${cwd}`],
  },
] as const satisfies ReadonlyArray<TerminalApplicationDefinition>;

export const TerminalApplicationId = Schema.Literals(
  TERMINAL_APPLICATIONS.map((terminal) => terminal.id),
);
export type TerminalApplicationId = typeof TerminalApplicationId.Type;

export const OpenInTerminalInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  terminal: TerminalApplicationId,
});
export type OpenInTerminalInput = typeof OpenInTerminalInput.Type;

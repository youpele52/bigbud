import type { ITerminalAddon, Terminal } from "@xterm/headless";

/** Pinned addons use the common headless API; their upstream types import lib.dom unnecessarily. */
export declare class SerializeAddon implements ITerminalAddon {
  activate(terminal: Terminal): void;
  serialize(): string;
  dispose(): void;
}
export declare class Unicode11Addon implements ITerminalAddon {
  activate(terminal: Terminal): void;
  dispose(): void;
}

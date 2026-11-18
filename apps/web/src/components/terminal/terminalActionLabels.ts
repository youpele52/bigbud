import type { ResolvedKeybindingsConfig } from "@bigbud/contracts/server/keybindings.ts";
import { MAX_TERMINALS_PER_GROUP } from "@bigbud/contracts/constants/terminal.constant.ts";
import { shortcutLabelForCommand } from "../../models/keybindings/keybindings.models";

export function terminalActionLabels(input: {
  keybindings: ResolvedKeybindingsConfig;
  hasReachedSplitLimit: boolean;
  splitShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
}) {
  const options = { context: { terminalFocus: true, terminalOpen: true } };
  const label = (
    command: "terminal.split" | "terminal.splitDown" | "terminal.close" | "terminal.find",
  ) => shortcutLabelForCommand(input.keybindings, command, options);
  const splits = [input.splitShortcutLabel ?? label("terminal.split"), label("terminal.splitDown")]
    .filter(Boolean)
    .join(" / ");
  const close = input.closeShortcutLabel ?? label("terminal.close");
  return {
    splitTerminalActionLabel: input.hasReachedSplitLimit
      ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
      : splits
        ? `Split Terminal (${splits})`
        : "Split Terminal",
    newTerminalActionLabel: input.newShortcutLabel
      ? `New Terminal (${input.newShortcutLabel})`
      : "New Terminal",
    closeTerminalActionLabel: close ? `Close Terminal (${close})` : "Close Terminal",
    closeShortcutLabel: close ?? undefined,
    findShortcutLabel: label("terminal.find") ?? undefined,
  };
}

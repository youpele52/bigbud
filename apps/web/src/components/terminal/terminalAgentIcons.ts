import { PROVIDER_DISPLAY_NAMES } from "@bigbud/contracts/constants/provider.constant.ts";
import type { TerminalOnlyAgentKind } from "@bigbud/contracts/constants/terminal.constant.ts";

import type { TerminalAgentKind } from "../../stores/terminal/terminal.store.agentKind";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/provider/ProviderModelPicker.models";
import type { Icon } from "../Icons";
import { HerdrIcon } from "./HerdrIcon";

const TERMINAL_ONLY_AGENT_ICONS: Record<TerminalOnlyAgentKind, Icon> = { herdr: HerdrIcon };
const TERMINAL_ONLY_AGENT_NAMES: Record<TerminalOnlyAgentKind, string> = { herdr: "herdr" };

function isTerminalOnly(kind: TerminalAgentKind): kind is TerminalOnlyAgentKind {
  return Object.hasOwn(TERMINAL_ONLY_AGENT_ICONS, kind);
}

/** Terminal pane logos: provider icons plus terminal-only exceptions that never reach chat pickers. */
export function terminalAgentIcon(kind: TerminalAgentKind): Icon {
  return isTerminalOnly(kind) ? TERMINAL_ONLY_AGENT_ICONS[kind] : PROVIDER_ICON_BY_PROVIDER[kind];
}

export function terminalAgentLabel(kind: TerminalAgentKind): string {
  return isTerminalOnly(kind)
    ? `Terminal: ${TERMINAL_ONLY_AGENT_NAMES[kind]}`
    : `Terminal provider: ${PROVIDER_DISPLAY_NAMES[kind]}`;
}

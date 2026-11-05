import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { selectThreadTerminalProvider } from "../../stores/terminal/terminal.store.recentAgent";
import { terminalAgentIcon, terminalAgentLabel } from "../terminal/terminalAgentIcons";
import { SidebarThreadProviderIcon } from "./SidebarThreadProviderIcon";

/** Keep the terminal identity independent of the chat provider; it only renders for a running terminal agent, so it breathes. */
export function SidebarThreadTerminalProviderIcon({ threadId }: { threadId: ThreadId }) {
  const provider = useTerminalStateStore((state) => selectThreadTerminalProvider(state, threadId));
  if (!provider) return null;
  const label = terminalAgentLabel(provider);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-slot="thread-terminal-provider-icon"
      className="inline-flex shrink-0"
    >
      <SidebarThreadProviderIcon
        icon={terminalAgentIcon(provider)}
        colorClass="text-info-foreground"
        animationClass="animate-breathe motion-reduce:animate-none"
      />
    </span>
  );
}

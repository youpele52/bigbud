import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { PROVIDER_DISPLAY_NAMES } from "@bigbud/contracts/constants/provider.constant.ts";

import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { selectThreadTerminalProvider } from "../../stores/terminal/terminal.store.recentAgent";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/provider/ProviderModelPicker.models";
import { SidebarThreadProviderIcon } from "./SidebarThreadProviderIcon";

/** Keep the terminal identity independent of the chat provider and its working animation. */
export function SidebarThreadTerminalProviderIcon({ threadId }: { threadId: ThreadId }) {
  const provider = useTerminalStateStore((state) => selectThreadTerminalProvider(state, threadId));
  if (!provider) return null;
  const label = `Terminal provider: ${PROVIDER_DISPLAY_NAMES[provider]}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-slot="thread-terminal-provider-icon"
      className="inline-flex shrink-0"
    >
      <SidebarThreadProviderIcon
        icon={PROVIDER_ICON_BY_PROVIDER[provider]}
        colorClass="text-info-foreground"
        animationClass=""
      />
    </span>
  );
}

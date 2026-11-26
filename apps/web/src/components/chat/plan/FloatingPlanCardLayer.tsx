import type { ComponentProps } from "react";

import { TASKS_FLOATING_PANEL_POSITION_CLASS_NAME } from "../common/chatFloatingPanel.layout";
import { useChatFloatingPanelLayer } from "../common/chatFloatingPanel.order";
import { FloatingPlanCard } from "./FloatingPlanCard";

/** The Tasks panel, placed over the chat messages area and stacked with the other floating panels. */
export function FloatingPlanCardLayer(props: ComponentProps<typeof FloatingPlanCard>) {
  const layer = useChatFloatingPanelLayer("tasks");

  return (
    <div
      className={TASKS_FLOATING_PANEL_POSITION_CLASS_NAME}
      data-chat-floating-panel="tasks"
      {...layer}
    >
      <div className="pointer-events-auto w-full sm:w-[22rem]">
        <FloatingPlanCard {...props} />
      </div>
    </div>
  );
}

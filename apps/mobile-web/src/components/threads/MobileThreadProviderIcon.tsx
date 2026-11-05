import { CircleHelpIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { ProviderKind, type OrchestrationThread } from "@bigbud/contracts";

import { PROVIDER_ICON_BY_PROVIDER } from "~/components/chat/provider/ProviderModelPicker.models";

import { SIDEBAR_ICON_SIZE_CLASS } from "./threads.iconSizes";
import { resolveMobileProviderIconClassName } from "../../logic/mobileThreadStatus.logic";
import { getThreadLastVisitedAt } from "../../lib/mobileThreadVisit";
import { cn } from "../../lib/cn";

export function MobileThreadProviderIcon({ thread }: { thread: OrchestrationThread }) {
  const Icon = Schema.is(ProviderKind)(thread.modelSelection.provider)
    ? PROVIDER_ICON_BY_PROVIDER[thread.modelSelection.provider]
    : CircleHelpIcon;
  const isThreadRunning = thread.session?.status === "running";
  const lastVisitedAt = getThreadLastVisitedAt(thread.id);

  return (
    <Icon
      className={cn(
        SIDEBAR_ICON_SIZE_CLASS,
        "shrink-0",
        resolveMobileProviderIconClassName(
          thread,
          lastVisitedAt !== undefined ? lastVisitedAt : undefined,
        ),
        isThreadRunning ? "animate-breathe" : "",
      )}
    />
  );
}

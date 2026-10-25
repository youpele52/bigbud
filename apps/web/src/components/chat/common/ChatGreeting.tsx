import { useState } from "react";

import { BigbudLogo } from "../../sidebar/SidebarProjectItem";

export function ChatGreeting({
  greeting = null,
  shimmer = false,
}: {
  greeting?: string | null;
  shimmer?: boolean;
}) {
  const [shimmerFinished, setShimmerFinished] = useState(false);
  const isShimmering = shimmer && !shimmerFinished;

  return (
    <div
      onAnimationEnd={() => setShimmerFinished(true)}
      className={
        greeting
          ? "grid h-full min-h-fit min-w-0 grid-rows-[1fr_auto_1fr] justify-items-center"
          : "flex h-full items-center justify-center"
      }
    >
      {/* Lock both dimensions over the shared SVG's w-auto in either layout. */}
      <BigbudLogo
        className={`row-start-2 size-8! opacity-70 ${isShimmering ? "chat-greeting-mark-shimmer" : ""}`}
      />
      {greeting ? (
        <p
          className={`row-start-3 w-full max-w-2xl self-start px-4 pt-7 text-center text-2xl leading-snug font-thin text-foreground [overflow-wrap:anywhere] ${isShimmering ? "shimmer chat-greeting-message-shimmer" : ""}`}
        >
          {greeting}
        </p>
      ) : null}
    </div>
  );
}

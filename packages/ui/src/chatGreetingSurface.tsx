import { useState, type ComponentType } from "react";

import { cn } from "./cn";

/** Empty conversation presentation; eligibility and greeting selection stay with each host. */
export function ChatGreetingSurface({
  Logo,
  greeting = null,
  shimmer = false,
  className,
}: {
  Logo: ComponentType<{ className?: string }>;
  greeting?: string | null;
  shimmer?: boolean;
  className?: string;
}) {
  const [shimmerFinished, setShimmerFinished] = useState(false);
  const isShimmering = shimmer && !shimmerFinished;
  return (
    <div
      onAnimationEnd={() => setShimmerFinished(true)}
      className={cn(
        greeting
          ? "grid h-full min-h-fit min-w-0 grid-rows-[1fr_auto_1fr] justify-items-center"
          : "flex h-full items-center justify-center",
        className,
      )}
    >
      <Logo
        className={`row-start-2 size-8! opacity-70 ${isShimmering ? "chat-greeting-mark-shimmer" : ""}`}
      />
      {greeting ? (
        <p
          data-chat-greeting-copy="true"
          className={`row-start-3 w-full max-w-2xl self-start px-4 pt-7 text-center text-2xl leading-snug font-thin text-foreground [overflow-wrap:anywhere] ${isShimmering ? "shimmer chat-greeting-message-shimmer" : ""}`}
        >
          {greeting}
        </p>
      ) : null}
    </div>
  );
}

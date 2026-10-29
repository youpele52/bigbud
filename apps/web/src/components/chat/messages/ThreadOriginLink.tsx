import { Comment03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type { ThreadId } from "@bigbud/contracts";

export function ThreadOriginLink(props: {
  threadId: ThreadId;
  title: string;
  prefix?: string;
  available?: boolean;
}) {
  const content = (
    <>
      <HugeiconsIcon
        aria-hidden="true"
        className="size-3 shrink-0"
        icon={Comment03Icon}
        size={12}
        strokeWidth={1.5}
      />
      {props.prefix ? <span>{props.prefix}</span> : null}
      <span className="max-w-48 truncate font-medium">{props.title}</span>
    </>
  );
  if (props.available === false) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 px-1.5 py-1 text-xs text-muted-foreground">
        {content}
      </span>
    );
  }
  return (
    <Link
      to="/$threadId"
      params={{ threadId: props.threadId }}
      className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/60 bg-background/55 px-1.5 py-1 text-xs text-muted-foreground outline-hidden transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      title={`Open thread: ${props.title}`}
    >
      {content}
    </Link>
  );
}

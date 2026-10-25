import type { MessageOriginSegment } from "@bigbud/contracts/orchestration/orchestration.messageOrigin.ts";

import { useSidebarThreadSummaryById, useThreadById } from "~/stores/main";
import { ThreadOriginLink } from "./ThreadOriginLink";

function label(segment: MessageOriginSegment) {
  if (segment.actor === "automation") return "Automation from";
  if (segment.actor === "userAssignment") return "Assignment from";
  if (segment.kind === "handoff") return "Handoff from";
  return "Agent from";
}

export function visibleOriginSegments(
  segments: ReadonlyArray<MessageOriginSegment> | undefined,
): ReadonlyArray<MessageOriginSegment> {
  // Ordinary-user and unverified segments remain in the message body without
  // presenting a claimed source as a trusted clickable attribution.
  return segments?.filter((segment) => segment.verified && segment.sourceThreads.length > 0) ?? [];
}

export function isOriginSourceAvailable(thread: unknown, summary: unknown): boolean {
  return thread !== undefined || summary !== undefined;
}

function AvailableOriginLink(props: {
  source: MessageOriginSegment["sourceThreads"][number];
  prefix: string;
}) {
  const thread = useThreadById(props.source.threadId);
  const summary = useSidebarThreadSummaryById(props.source.threadId);
  return (
    <ThreadOriginLink
      threadId={props.source.threadId}
      title={props.source.title}
      prefix={props.prefix}
      available={isOriginSourceAvailable(thread, summary)}
    />
  );
}

export function MessagesTimelineOrigins(props: {
  segments: ReadonlyArray<MessageOriginSegment> | undefined;
}) {
  const sourced = visibleOriginSegments(props.segments);
  if (sourced.length === 0) return null;

  return (
    <div className="mb-2 space-y-1.5" aria-label="Message sources">
      {sourced.map((segment) => (
        <div
          key={`${segment.kind}:${segment.text}:${segment.sourceThreads.map((source) => source.threadId).join(",")}`}
          className="rounded-md border border-border/50 bg-background/35 p-1.5"
        >
          <div className="flex flex-wrap gap-1">
            {segment.sourceThreads.map((source, index) => (
              <AvailableOriginLink
                key={source.threadId}
                source={source}
                prefix={index === 0 ? label(segment) : "and"}
              />
            ))}
          </div>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground/75">
            {segment.text}
          </p>
        </div>
      ))}
    </div>
  );
}

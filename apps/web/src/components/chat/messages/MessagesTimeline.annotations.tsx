import { Code2Icon, MousePointerSquareDashedIcon, TerminalIcon } from "lucide-react";
import type { ParsedUserAnnotationEntry } from "~/lib/terminalContext";
import { ActivityAccordion } from "../common/ActivityAccordion";
import { ChatCitationChip } from "../common/ChatCitationChip";

function annotationLabel(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

export function MessagesTimelineAnnotations(props: { annotations: ParsedUserAnnotationEntry[] }) {
  const occurrences = new Map<string, number>();
  const citations = props.annotations
    .filter((annotation) => annotation.kind === "chat")
    .map((citation) => {
      const sourceKey = JSON.stringify([
        citation.source,
        citation.selection.startOffset,
        citation.selection.endOffset,
      ]);
      const occurrence = occurrences.get(sourceKey) ?? 0;
      occurrences.set(sourceKey, occurrence + 1);
      return { citation, key: `${sourceKey}:${occurrence}` };
    });
  const annotations = props.annotations.filter((annotation) => annotation.kind !== "chat");
  return (
    <>
      {citations.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2" aria-label="Citations">
          {citations.map(({ citation, key }) => (
            <ChatCitationChip key={key} citation={citation} />
          ))}
        </div>
      ) : null}
      <MessagesTimelineSurfaceAnnotations annotations={annotations} />
    </>
  );
}

function MessagesTimelineSurfaceAnnotations(props: {
  annotations: Exclude<ParsedUserAnnotationEntry, { kind: "chat" }>[];
}) {
  const { annotations } = props;
  if (annotations.length === 0) return null;

  return (
    <ActivityAccordion
      variant="compact"
      title={
        <span className="inline-flex items-center gap-1.5">
          <MousePointerSquareDashedIcon className="size-3.5 shrink-0 text-info" />
          {annotationLabel(annotations.length)}
        </span>
      }
      className="mb-2"
      summaryClassName="rounded-lg border border-border/80 bg-background px-2.5 py-1.5 text-foreground/80 transition-colors hover:bg-muted/40"
      panelClassName="space-y-2 pl-1"
    >
      {annotations.map((annotation, index) => {
        const icon =
          annotation.kind === "browser" ? (
            <MousePointerSquareDashedIcon className="mt-0.5 size-3.5 shrink-0 text-info" />
          ) : annotation.kind === "terminal" ? (
            <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-info" />
          ) : (
            <Code2Icon className="mt-0.5 size-3.5 shrink-0 text-info" />
          );
        const title = annotation.comment || `Annotation ${index + 1}`;
        const subtitle =
          annotation.kind === "browser"
            ? annotation.pageTitle || annotation.pageUrl
            : annotation.kind === "terminal"
              ? annotation.terminalLabel
              : annotation.projectName
                ? `${annotation.projectName} > ${annotation.path}`
                : annotation.path;
        const detail =
          annotation.kind === "browser"
            ? annotation.selector || annotation.tag
            : annotation.lineLabel;

        return (
          <div
            key={`annotation:${annotation.kind}:${annotation.text}`}
            className="rounded-lg border border-border/60 bg-background/35 p-2.5"
          >
            <div className="flex items-start gap-2">
              {icon}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="truncate text-xs font-medium text-foreground">{title}</div>
                {subtitle ? (
                  <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
                ) : null}
                {detail ? (
                  <div className="truncate text-sm font-light text-muted-foreground/80">
                    {detail}
                  </div>
                ) : null}
              </div>
            </div>
            {annotation.kind === "browser" ? (
              <div className="mt-2 whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background/45 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground/70">
                {annotation.text}
              </div>
            ) : (
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background/45 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
                {annotation.kind === "terminal"
                  ? annotation.selectedOutput
                  : annotation.selectedCode}
              </pre>
            )}
          </div>
        );
      })}
    </ActivityAccordion>
  );
}

import {
  ChevronDownIcon,
  Code2Icon,
  MousePointerSquareDashedIcon,
  TerminalIcon,
} from "lucide-react";
import type { ParsedUserAnnotationEntry } from "~/lib/terminalContext";

function annotationLabel(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

export function MessagesTimelineAnnotations(props: { annotations: ParsedUserAnnotationEntry[] }) {
  const { annotations } = props;
  if (annotations.length === 0) return null;

  return (
    <details className="mb-2 group/annotations">
      <summary className="list-none">
        <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/80 bg-background px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted/40">
          <MousePointerSquareDashedIcon className="size-3.5 shrink-0 text-info" />
          <span>{annotationLabel(annotations.length)}</span>
          <ChevronDownIcon className="size-3 shrink-0 -rotate-90 text-muted-foreground/70 transition-transform duration-150 group-open/annotations:rotate-0" />
        </span>
      </summary>
      <div className="mt-2 space-y-2 pl-1">
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
                    <div className="truncate font-mono text-[11px] text-muted-foreground/80">
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
      </div>
    </details>
  );
}

import { CircleAlertIcon } from "lucide-react";

export const pendingApprovalSurfaceStyles = {
  frame:
    "mx-auto w-full max-w-[calc(52rem*2/3)] overflow-hidden rounded-[20px] border border-warning/35 bg-warning/5 shadow-xs",
  body: "space-y-2 px-3 py-2.5",
  description: "text-muted-foreground text-xs leading-5",
  detail:
    "max-h-28 overflow-auto rounded-lg border border-border/70 bg-muted/35 p-2 text-xs whitespace-pre-wrap break-words text-foreground",
} as const;

export function PendingApprovalHeader({ summary }: { readonly summary: string }) {
  return (
    <header className="flex items-start gap-2 border-b border-warning/20 px-3 py-2.5">
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0">
        <p className="font-medium text-sm text-foreground">Approval required</p>
        <p className="mt-0.5 text-muted-foreground text-xs">{summary}</p>
      </div>
    </header>
  );
}

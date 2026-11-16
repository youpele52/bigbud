import { cn } from "../../lib/cn";
import {
  buildMobileConnectionDiagnostics,
  type MobileConnectionDiagnosticsInput,
  type MobileDiagnosticStatus,
} from "../../logic/mobileConnectionDiagnostics.logic";

const STATUS_LABELS: Record<MobileDiagnosticStatus, string> = {
  ok: "OK",
  failed: "Failed",
  pending: "In progress",
  "not-run": "Not checked",
};

const STATUS_CLASSES: Record<MobileDiagnosticStatus, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  pending: "text-blue-600 dark:text-blue-400",
  "not-run": "text-muted-foreground",
};

/** Redacted, staged connection details. Shows origins only, never tokens or secrets. */
export function MobileConnectionDiagnostics(props: MobileConnectionDiagnosticsInput) {
  // Pure and cheap: a handful of string checks per render.
  const diagnostics = buildMobileConnectionDiagnostics(props);

  return (
    <details className="rounded-lg border border-border/70 px-3 py-2 text-xs">
      <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-foreground">
        Connection details
      </summary>
      <ol aria-label="Connection checks" className="mt-2 grid gap-2">
        {diagnostics.stages.map((stage) => (
          <li className="grid gap-0.5" key={stage.stage}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-foreground">{stage.label}</span>
              <span className={cn("shrink-0", STATUS_CLASSES[stage.status])}>
                {STATUS_LABELS[stage.status]}
              </span>
            </div>
            <span className="break-words text-muted-foreground">{stage.detail}</span>
          </li>
        ))}
      </ol>
      {diagnostics.findings.length > 0 ? (
        <ul
          aria-label="What to check"
          className="mt-3 grid list-disc gap-1 pl-4 text-muted-foreground"
        >
          {diagnostics.findings.map((finding) => (
            <li key={finding}>{finding}</li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

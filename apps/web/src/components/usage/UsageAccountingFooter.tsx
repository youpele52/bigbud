import type { ServerUsageSummaryResult } from "@bigbud/contracts";

/** This disclosure is independent of dismissible provider-availability warnings. */
export function UsageAccountingFooter({ summary }: { readonly summary: ServerUsageSummaryResult }) {
  const estimatedProviders = summary.providers
    .filter(
      (entry) => entry.accounting?.source === "estimated" || entry.accounting?.source === "mixed",
    )
    .map((entry) => (entry.id === "unknown" ? "Unknown provider" : entry.label));
  return (
    <footer
      className="space-y-1 text-xs text-muted-foreground"
      aria-label="Usage accounting disclosure"
    >
      {!summary.totals.accounting ? (
        <p>Source unavailable: this server did not provide accounting provenance.</p>
      ) : null}
      {estimatedProviders.length > 0 ? (
        <p>
          Estimated usage: {estimatedProviders.join(", ")} include estimates calculated by bigbud
          using observable-text-v1 (one token per four Unicode code points, rounded up per message).
          Unofficial observable-content estimates may omit internal context, reasoning, and model
          calls. They are not billing-accurate.
        </p>
      ) : null}
      {summary.totals.accounting?.partial || summary.totals.accounting?.legacy ? (
        <p>
          Usage includes partial or unverified historical counts. Official counts suppress
          overlapping estimates, even when incomplete.
        </p>
      ) : null}
    </footer>
  );
}

/** Dated JSON and markdown matrix for the provider conformance harness (WP-5D). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redactDeep } from "./redact.ts";
import { PROMPTS, ROWS, type Provider, type RowResult, type RowStatus } from "./rows.ts";

export type RunMode = "live" | "self-test" | "dry-run";

export interface ConformanceReport {
  readonly tool: "providerConformance";
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: RunMode;
  /**
   * `none`: self-test against the mock provider or a dry run. Never acceptance evidence.
   * `candidate`: a live run where every row passed or is declared unsupported; the user
   * still reviews it for M4. `failed`: a live run with a failing or not-run row.
   */
  readonly acceptance: "none" | "candidate" | "failed";
  readonly acceptanceNote: string;
  readonly tuple: string;
  readonly transport: string;
  readonly backendVersion: string | null;
  readonly providers: ReadonlyArray<Provider>;
  readonly results: ReadonlyArray<RowResult>;
  readonly counts: Readonly<Record<RowStatus, number>>;
  readonly cleanupProblems: ReadonlyArray<string>;
}

export function countStatuses(results: ReadonlyArray<RowResult>): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = {
    pass: 0,
    fail: 0,
    "unsupported-by-provider": 0,
    "not-run": 0,
  };
  for (const entry of results) counts[entry.status] += 1;
  return counts;
}

export function acceptanceFor(mode: RunMode, results: ReadonlyArray<RowResult>) {
  if (mode !== "live")
    return {
      acceptance: "none" as const,
      acceptanceNote:
        mode === "self-test"
          ? "SELF-TEST against a mock provider: exercises the harness only. No acceptance."
          : "DRY RUN: nothing was executed. No acceptance.",
    };
  const clean = results.every(
    (entry) => entry.status === "pass" || entry.status === "unsupported-by-provider",
  );
  return clean
    ? {
        acceptance: "candidate" as const,
        acceptanceNote: "Every row passed or is declared unsupported. Review before recording M4.",
      }
    : {
        acceptance: "failed" as const,
        acceptanceNote: "At least one row failed or did not run. Not acceptance.",
      };
}

export function buildReport(
  input: Omit<
    ConformanceReport,
    "tool" | "schemaVersion" | "counts" | "acceptance" | "acceptanceNote"
  >,
): ConformanceReport {
  return redactDeep({
    tool: "providerConformance",
    schemaVersion: 1,
    ...input,
    ...acceptanceFor(input.mode, input.results),
    counts: countStatuses(input.results),
  });
}

const CELL: Record<RowStatus, string> = {
  pass: "pass",
  fail: "**FAIL**",
  "unsupported-by-provider": "unsupported",
  "not-run": "not-run",
};

const escapeCell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");

/** Render an already redacted report; nothing here re-reads unredacted data. */
export function renderMarkdown(report: ConformanceReport): string {
  const find = (row: string, provider: string) =>
    report.results.find((entry) => entry.row === row && entry.provider === provider);
  const providerRows = ROWS.filter((row) => row.scope === "provider");
  const backendRows = ROWS.filter((row) => row.scope === "backend");
  const lines = [
    `# Provider conformance ${report.startedAt.slice(0, 10)} (${report.mode})`,
    "",
    `> **${report.acceptanceNote}**`,
    "",
    `Tuple \`${report.tuple}\`, transport \`${report.transport}\`, backend ${report.backendVersion ?? "unknown"}.`,
    `Counts: ${report.counts.pass} pass, ${report.counts.fail} fail, ` +
      `${report.counts["unsupported-by-provider"]} unsupported, ${report.counts["not-run"]} not-run.`,
    "",
    "## Matrix",
    "",
    `| Row | ${report.providers.join(" | ")} |`,
    `| --- | ${report.providers.map(() => "---").join(" | ")} |`,
    ...providerRows.map(
      (row) =>
        `| ${row.title} | ${report.providers
          .map((provider) => {
            const entry = find(row.id, provider);
            return entry ? CELL[entry.status] : "-";
          })
          .join(" | ")} |`,
    ),
    "",
    ...backendRows.map((row) => {
      const entry = find(row.id, "backend");
      return `Backend row ${row.title}: ${entry ? `${CELL[entry.status]} (${escapeCell(entry.reason)})` : "-"}`;
    }),
    "",
    "## Details",
    "",
    "| Provider | Row | Status | Reason | Evidence | ms |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.results.map(
      (entry) =>
        `| ${entry.provider} | ${entry.row} | ${entry.status} | ${escapeCell(entry.reason)} | ` +
        `${escapeCell(
          Object.entries(entry.evidence)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(", "),
        )} | ${entry.durationMs} |`,
    ),
    "",
    "## Fixed prompts",
    "",
    ...Object.entries(PROMPTS).map(([id, text]) => `- \`${id}\`: ${escapeCell(text)}`),
    "",
    report.cleanupProblems.length === 0
      ? "Cleanup: every conformance thread and the project were removed."
      : `Cleanup problems: ${report.cleanupProblems.map(escapeCell).join("; ")}`,
    "",
  ];
  return lines.join("\n");
}

export function writeReport(outDir: string, report: ConformanceReport) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = report.startedAt.replaceAll(":", "").replace(/\.\d+Z$/u, "Z");
  const base = `provider-conformance-${report.mode}-${stamp}`;
  const json = join(outDir, `${base}.json`);
  const markdown = join(outDir, `${base}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdown, renderMarkdown(report), { mode: 0o600 });
  return { json, markdown };
}

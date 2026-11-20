#!/usr/bin/env node
/**
 * Release gate: waits until the `CI passed` job of a `ci.yml` push or dispatch run succeeded for
 * the exact commit being released, then exits 0. Exits 1 on a failed or missing CI verdict or at the
 * deadline. Node built-ins only, so the gate job needs no dependency install.
 *
 *   node scripts/wait-for-ci-verdict.ts --repo <owner/name> --sha <40-hex> [--workflow ci.yml]
 *     [--job "CI passed"] [--timeout-minutes 70] [--missing-grace-minutes 10] [--poll-seconds 30]
 *
 * Token: `GITHUB_TOKEN` (then `GH_TOKEN`); needs `actions: read`.
 */
import { appendFileSync } from "node:fs";

import { parseCiVerdictArgs } from "./lib/ci-verdict.args.ts";
import { waitForCiVerdict } from "./lib/ci-verdict.poll.ts";

const args = parseCiVerdictArgs(process.argv.slice(2));
console.log(
  `Waiting up to ${args.timeoutMinutes} min for '${args.jobName}' in ${args.workflow} on ${args.repo}@${args.sha}.`,
);
const verdict = await waitForCiVerdict({
  repo: args.repo,
  sha: args.sha,
  workflow: args.workflow,
  jobName: args.jobName,
  timeoutMs: args.timeoutMinutes * 60_000,
  missingGraceMs: args.missingGraceMinutes * 60_000,
  pollMs: args.pollSeconds * 1_000,
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
  log: (message) => console.log(message),
});

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
let summary: string;
if (verdict.kind === "pass") {
  summary = `### CI gate\n\n'${args.jobName}' succeeded for \`${args.sha}\`: ${verdict.run.htmlUrl}\n`;
  console.log(summary);
} else {
  summary = `### CI gate\n\nFailed for \`${args.sha}\`.\n\n\`\`\`\n${verdict.message}\n\`\`\`\n`;
  console.log(`::error title=CI gate failed::${verdict.message.replace(/\n/g, "%0A")}`);
  process.exitCode = 1;
}
if (summaryPath) appendFileSync(summaryPath, summary);

/**
 * Release gate decision: did the `CI passed` job of a `ci.yml` run succeed for the exact commit
 * being released? Pure logic only (GitHub response parsing and the decision). Polling and HTTP
 * live in `ci-verdict.poll.ts`; the CLI is `scripts/wait-for-ci-verdict.ts`.
 *
 * Only `push` and `workflow_dispatch` runs from this repository count. `pull_request` runs test a
 * merge commit, not the tagged SHA, and fork runs are not this repository's CI.
 */

export const ACCEPTED_EVENTS: ReadonlySet<string> = new Set(["push", "workflow_dispatch"]);

export interface CiRun {
  readonly id: number;
  readonly headSha: string;
  readonly event: string;
  /** `queued`, `in_progress`, `completed`, ... */
  readonly status: string;
  readonly conclusion: string | null;
  readonly headRepository: string | null;
  readonly runAttempt: number;
  readonly htmlUrl: string;
}

export interface CiJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runAttempt: number;
}

export interface CandidateRun {
  readonly run: CiRun;
  /** Jobs of the run's latest attempt. */
  readonly jobs: ReadonlyArray<CiJob>;
}

export interface VerdictInput {
  readonly repo: string;
  readonly sha: string;
  readonly jobName: string;
  readonly candidates: ReadonlyArray<CandidateRun>;
  readonly elapsedMs: number;
  readonly missingGraceMs: number;
}

export type Verdict =
  | { readonly kind: "pass"; readonly run: CiRun }
  | { readonly kind: "wait"; readonly reason: string }
  | { readonly kind: "fail"; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${label} has no string '${key}'.`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} has no numeric '${key}'.`);
  }
  return value;
}

/** Parses `GET /repos/{repo}/actions/workflows/{workflow}/runs`. */
export function parseWorkflowRuns(value: unknown): CiRun[] {
  if (!isRecord(value) || !Array.isArray(value.workflow_runs)) {
    throw new Error("Workflow runs response has no 'workflow_runs' array.");
  }
  return value.workflow_runs.map((entry, index): CiRun => {
    const label = `workflow_runs[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} is not an object.`);
    const repository = isRecord(entry.head_repository) ? entry.head_repository : undefined;
    return {
      id: requireNumber(entry, "id", label),
      headSha: requireString(entry, "head_sha", label),
      event: requireString(entry, "event", label),
      status: requireString(entry, "status", label),
      conclusion: stringOrNull(entry.conclusion),
      headRepository: stringOrNull(repository?.full_name),
      runAttempt: typeof entry.run_attempt === "number" ? entry.run_attempt : 1,
      htmlUrl: typeof entry.html_url === "string" ? entry.html_url : "",
    };
  });
}

/** Parses `GET /repos/{repo}/actions/runs/{id}/jobs`. Returns the jobs and the reported total. */
export function parseRunJobs(value: unknown): { jobs: CiJob[]; totalCount: number } {
  if (!isRecord(value) || !Array.isArray(value.jobs)) {
    throw new Error("Run jobs response has no 'jobs' array.");
  }
  const jobs = value.jobs.map((entry, index): CiJob => {
    const label = `jobs[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} is not an object.`);
    return {
      name: requireString(entry, "name", label),
      status: requireString(entry, "status", label),
      conclusion: stringOrNull(entry.conclusion),
      runAttempt: typeof entry.run_attempt === "number" ? entry.run_attempt : 1,
    };
  });
  const totalCount = typeof value.total_count === "number" ? value.total_count : jobs.length;
  return { jobs, totalCount };
}

/** Runs that may vouch for `sha`: exact head SHA, this repository, push or dispatch only. */
export function selectCandidateRuns(
  runs: ReadonlyArray<CiRun>,
  repo: string,
  sha: string,
): CiRun[] {
  return runs.filter(
    (run) => run.headSha === sha && run.headRepository === repo && ACCEPTED_EVENTS.has(run.event),
  );
}

/** The verdict job of the run's latest attempt, if it exists. */
export function verdictJob(candidate: CandidateRun, jobName: string): CiJob | undefined {
  return candidate.jobs.find(
    (job) => job.name === jobName && job.runAttempt === candidate.run.runAttempt,
  );
}

const describeRun = (candidate: CandidateRun, jobName: string): string => {
  const { run } = candidate;
  const job = verdictJob(candidate, jobName);
  const verdict = job ? `${job.status}/${job.conclusion ?? "none"}` : "missing";
  return `run ${run.id} (${run.event}, attempt ${run.runAttempt}): ${run.status}/${run.conclusion ?? "none"}, '${jobName}' ${verdict} ${run.htmlUrl}`.trimEnd();
};

export const dispatchHint = (repo: string, jobName: string) =>
  `Run: gh workflow run ci.yml --repo ${repo} --ref <tag or branch>, wait for '${jobName}', ` +
  "then re-run this release's failed jobs.";

/** One poll's decision. The caller turns a `wait` past its deadline into a failure. */
export function decideVerdict(input: VerdictInput): Verdict {
  const { candidates, jobName } = input;
  const passed = candidates.find((candidate) => {
    const job = verdictJob(candidate, jobName);
    return job?.status === "completed" && job.conclusion === "success";
  });
  if (passed) return { kind: "pass", run: passed.run };

  const running = candidates.filter((candidate) => candidate.run.status !== "completed");
  if (running.length > 0) {
    return {
      kind: "wait",
      reason: `CI is still running for ${input.sha}: ${running.map((c) => describeRun(c, jobName)).join("; ")}`,
    };
  }
  if (candidates.length === 0) {
    if (input.elapsedMs < input.missingGraceMs) {
      return { kind: "wait", reason: `No push or dispatch CI run for ${input.sha} yet.` };
    }
    return {
      kind: "fail",
      message: `No CI run for ${input.sha} in ${input.repo}. ${dispatchHint(input.repo, jobName)}`,
    };
  }
  const runs = candidates.map((candidate) => `\n  - ${describeRun(candidate, jobName)}`).join("");
  return {
    kind: "fail",
    message:
      `No CI run for ${input.sha} has a successful '${jobName}' job:${runs}\n` +
      `Fix or re-run CI for this commit, then re-run this release's failed jobs.`,
  };
}

/**
 * Polls the GitHub REST API until `decideVerdict` passes or fails, or the deadline is reached.
 * Requests are bounded (per-request timeout, retries with backoff). An API or network error is
 * never a pass: it only delays the decision until the deadline.
 */
import {
  decideVerdict,
  parseRunJobs,
  parseWorkflowRuns,
  selectCandidateRuns,
  type CandidateRun,
  type CiJob,
  type Verdict,
} from "./ci-verdict.ts";

export interface WaitForCiVerdictOptions {
  readonly repo: string;
  readonly sha: string;
  /** Workflow file name, for example `ci.yml`. */
  readonly workflow: string;
  readonly jobName: string;
  readonly timeoutMs: number;
  readonly missingGraceMs: number;
  readonly pollMs: number;
  readonly token: string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly requestTimeoutMs?: number;
  readonly requestAttempts?: number;
  readonly retryDelayMs?: number;
  readonly apiBase?: string;
}

export type FinalVerdict = Exclude<Verdict, { kind: "wait" }>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;
/** Jobs pages per run (100 jobs each); the CI workflow has far fewer. */
const MAX_JOB_PAGES = 5;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fetches JSON with a per-request timeout and retries 5xx, 429 and network errors. */
async function getJson(url: string, options: WaitForCiVerdictOptions): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = options.requestAttempts ?? DEFAULT_REQUEST_ATTEMPTS;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    // A generic, non-identifying client name.
    "user-agent": "bigbud-release-ci-gate",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
      const retryable = response.status >= 500 || response.status === 429;
      if (!retryable) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await sleep((options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * attempt);
  }
  throw new Error(`GET ${url} failed: ${lastError}`);
}

async function latestAttemptJobs(
  runId: number,
  options: WaitForCiVerdictOptions,
  apiBase: string,
): Promise<CiJob[]> {
  const jobs: CiJob[] = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const url = `${apiBase}/repos/${options.repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`;
    const parsed = parseRunJobs(await getJson(url, options));
    jobs.push(...parsed.jobs);
    if (parsed.jobs.length === 0 || jobs.length >= parsed.totalCount) break;
  }
  return jobs;
}

/** One poll: list runs for the SHA, then read the latest-attempt jobs of every candidate run. */
export async function collectCandidates(options: WaitForCiVerdictOptions): Promise<CandidateRun[]> {
  const apiBase = options.apiBase ?? "https://api.github.com";
  const runsUrl =
    `${apiBase}/repos/${options.repo}/actions/workflows/${encodeURIComponent(options.workflow)}` +
    `/runs?head_sha=${options.sha}&per_page=100`;
  const runs = selectCandidateRuns(
    parseWorkflowRuns(await getJson(runsUrl, options)),
    options.repo,
    options.sha,
  );
  const candidates: CandidateRun[] = [];
  for (const run of runs) {
    candidates.push({ run, jobs: await latestAttemptJobs(run.id, options, apiBase) });
  }
  return candidates;
}

/** Polls until pass or fail. A `wait` at or past the deadline becomes a failure. */
export async function waitForCiVerdict(options: WaitForCiVerdictOptions): Promise<FinalVerdict> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => {});
  const start = now();
  for (;;) {
    let verdict: Verdict;
    try {
      verdict = decideVerdict({
        repo: options.repo,
        sha: options.sha,
        jobName: options.jobName,
        candidates: await collectCandidates(options),
        elapsedMs: now() - start,
        missingGraceMs: options.missingGraceMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      verdict = { kind: "wait", reason: `GitHub API error (not a pass): ${message}` };
    }
    if (verdict.kind !== "wait") return verdict;
    const elapsed = now() - start;
    if (elapsed >= options.timeoutMs) {
      const minutes = Math.round(options.timeoutMs / 60_000);
      return {
        kind: "fail",
        message: `Timed out after ${minutes} min waiting for '${options.jobName}'. Last state: ${verdict.reason}`,
      };
    }
    log(`Waiting: ${verdict.reason}`);
    await sleep(Math.min(options.pollMs, options.timeoutMs - elapsed));
  }
}

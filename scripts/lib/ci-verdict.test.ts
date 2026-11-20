import { describe, expect, it } from "vitest";

import { decideVerdict, parseRunJobs, parseWorkflowRuns, selectCandidateRuns } from "./ci-verdict";
import type { CandidateRun, CiJob, CiRun, VerdictInput } from "./ci-verdict";

const REPO = "owner/bigbud";
const SHA = "a".repeat(40);
const JOB = "CI passed";
const GRACE = 10 * 60_000;

function run(overrides: Partial<CiRun> = {}): CiRun {
  return {
    id: 1,
    headSha: SHA,
    event: "push",
    status: "completed",
    conclusion: "success",
    headRepository: REPO,
    runAttempt: 1,
    htmlUrl: "https://github.com/owner/bigbud/actions/runs/1",
    ...overrides,
  };
}
const job = (overrides: Partial<CiJob> = {}): CiJob => ({
  name: JOB,
  status: "completed",
  conclusion: "success",
  runAttempt: 1,
  ...overrides,
});
const candidate = (runOverrides: Partial<CiRun> = {}, jobs: CiJob[] = [job()]): CandidateRun => ({
  run: run(runOverrides),
  jobs,
});
const decide = (candidates: CandidateRun[], overrides: Partial<VerdictInput> = {}) =>
  decideVerdict({
    repo: REPO,
    sha: SHA,
    jobName: JOB,
    candidates,
    elapsedMs: 0,
    missingGraceMs: GRACE,
    ...overrides,
  });

describe("CI verdict decision", () => {
  it("passes when the latest attempt's CI passed job succeeded", () => {
    expect(decide([candidate()])).toMatchObject({ kind: "pass", run: { id: 1 } });
  });

  it("does not pass a successful run without a CI passed job", () => {
    const verdict = decide([candidate({}, [job({ name: "Format and lint" })])]);
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail") expect(verdict.message).toContain("'CI passed' missing");
  });

  it("only matches the job name exactly", () => {
    expect(decide([candidate({}, [job({ name: "CI passed (old)" })])]).kind).toBe("fail");
  });

  it("waits while a candidate run is in progress", () => {
    const verdict = decide([
      candidate({ status: "in_progress", conclusion: null }, [job({ status: "queued" })]),
    ]);
    expect(verdict).toMatchObject({ kind: "wait" });
  });

  it("fails when every run completed and none passed, listing each run", () => {
    const verdict = decide([
      candidate({ id: 7, conclusion: "failure" }, [job({ conclusion: "failure" })]),
      candidate({ id: 8, event: "workflow_dispatch", conclusion: "cancelled" }, []),
    ]);
    expect(verdict.kind).toBe("fail");
    if (verdict.kind !== "fail") return;
    expect(verdict.message).toContain("run 7 (push, attempt 1): completed/failure");
    expect(verdict.message).toContain("run 8 (workflow_dispatch, attempt 1): completed/cancelled");
  });

  it("waits for a missing run during the grace period, then fails with the dispatch hint", () => {
    expect(decide([], { elapsedMs: GRACE - 1 }).kind).toBe("wait");
    const verdict = decide([], { elapsedMs: GRACE });
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail") {
      expect(verdict.message).toContain(`No CI run for ${SHA}`);
      expect(verdict.message).toContain(`gh workflow run ci.yml --repo ${REPO} --ref`);
    }
  });

  it("lets any passing candidate win over failed or running ones", () => {
    const verdict = decide([
      candidate({ id: 2, conclusion: "failure" }, [job({ conclusion: "failure" })]),
      candidate({ id: 3, status: "in_progress", conclusion: null }, []),
      candidate({ id: 4, event: "workflow_dispatch" }),
    ]);
    expect(verdict).toMatchObject({ kind: "pass", run: { id: 4 } });
  });

  it("ignores a success that belongs to an earlier attempt", () => {
    const rerun = candidate({ runAttempt: 2, conclusion: "failure" }, [
      job({ runAttempt: 1 }),
      job({ runAttempt: 2, conclusion: "failure" }),
    ]);
    expect(decide([rerun]).kind).toBe("fail");
  });
});

describe("CI run selection and parsing", () => {
  const runs = [
    run({ id: 1 }),
    run({ id: 2, event: "pull_request" }),
    run({ id: 3, headRepository: "fork/bigbud" }),
    run({ id: 4, headSha: "b".repeat(40) }),
    run({ id: 5, event: "workflow_dispatch" }),
    run({ id: 6, headRepository: null }),
  ];

  it("keeps only push and dispatch runs of this repository on the exact SHA", () => {
    expect(selectCandidateRuns(runs, REPO, SHA).map((entry) => entry.id)).toEqual([1, 5]);
  });

  it("parses workflow runs and jobs responses", () => {
    expect(
      parseWorkflowRuns({
        workflow_runs: [
          {
            id: 9,
            head_sha: SHA,
            event: "push",
            status: "completed",
            conclusion: "success",
            head_repository: { full_name: REPO },
            run_attempt: 2,
            html_url: "https://example.invalid/9",
          },
        ],
      }),
    ).toEqual([run({ id: 9, runAttempt: 2, htmlUrl: "https://example.invalid/9" })]);
    expect(
      parseRunJobs({
        total_count: 1,
        jobs: [{ name: JOB, status: "completed", conclusion: "success", run_attempt: 2 }],
      }),
    ).toEqual({ jobs: [job({ runAttempt: 2 })], totalCount: 1 });
  });

  it("rejects malformed responses instead of guessing", () => {
    expect(() => parseWorkflowRuns({ message: "Not Found" })).toThrow("workflow_runs");
    expect(() => parseWorkflowRuns({ workflow_runs: [{ id: 1 }] })).toThrow("head_sha");
    expect(() => parseRunJobs({ jobs: [{ status: "completed" }] })).toThrow("'name'");
  });
});

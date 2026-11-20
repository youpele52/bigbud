import { describe, expect, it } from "vitest";

import { parseCiVerdictArgs } from "./ci-verdict.args";
import { waitForCiVerdict } from "./ci-verdict.poll";
import type { WaitForCiVerdictOptions } from "./ci-verdict.poll";

const REPO = "owner/bigbud";
const SHA = "c".repeat(40);
const API = "https://api.test";

type Responder = (url: string) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const runsBody = (status: string, conclusion: string | null, event = "push") => ({
  workflow_runs: [
    {
      id: 11,
      head_sha: SHA,
      event,
      status,
      conclusion,
      head_repository: { full_name: REPO },
      run_attempt: 1,
      html_url: "https://github.com/owner/bigbud/actions/runs/11",
    },
  ],
});
const jobsBody = (status: string, conclusion: string | null) => ({
  total_count: 1,
  jobs: [{ name: "CI passed", status, conclusion, run_attempt: 1 }],
});

/** A fake clock: `sleep` advances time, so the polling loop runs instantly. */
function harness(responders: Responder[], overrides: Partial<WaitForCiVerdictOptions> = {}) {
  let time = 0;
  let call = 0;
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const options: WaitForCiVerdictOptions = {
    repo: REPO,
    sha: SHA,
    workflow: "ci.yml",
    jobName: "CI passed",
    timeoutMs: 70 * 60_000,
    missingGraceMs: 10 * 60_000,
    pollMs: 30_000,
    token: "token-value",
    apiBase: API,
    requestAttempts: 2,
    retryDelayMs: 1,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      headers.push((init?.headers ?? {}) as Record<string, string>);
      const responder = responders[Math.min(call, responders.length - 1)]!;
      call += 1;
      return responder(url);
    }) as typeof fetch,
    ...overrides,
  };
  return { options, urls, headers, elapsed: () => time };
}

const byPath =
  (runs: unknown, jobs: unknown): Responder =>
  (url) =>
    json(url.includes("/jobs?") ? jobs : runs);

describe("waitForCiVerdict", () => {
  it("passes on the first poll when CI already passed, using the exact SHA and latest jobs", async () => {
    const { options, urls, headers } = harness([
      byPath(runsBody("completed", "success"), jobsBody("completed", "success")),
    ]);
    await expect(waitForCiVerdict(options)).resolves.toMatchObject({ kind: "pass" });
    expect(urls[0]).toBe(
      `${API}/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=100`,
    );
    expect(urls[1]).toBe(
      `${API}/repos/${REPO}/actions/runs/11/jobs?filter=latest&per_page=100&page=1`,
    );
    expect(headers[0]?.authorization).toBe("Bearer token-value");
  });

  it("keeps polling while CI runs and passes once CI passed succeeds", async () => {
    const running = byPath(runsBody("in_progress", null), jobsBody("queued", null));
    const done = byPath(runsBody("completed", "success"), jobsBody("completed", "success"));
    // Two requests per poll: runs, then jobs.
    const { options, elapsed } = harness([running, running, running, running, done]);
    await expect(waitForCiVerdict(options)).resolves.toMatchObject({ kind: "pass" });
    expect(elapsed()).toBe(60_000);
  });

  it("never treats API errors as a pass and fails at the deadline", async () => {
    const { options, elapsed } = harness([() => json({ message: "boom" }, 502)], {
      timeoutMs: 5 * 60_000,
    });
    const verdict = await waitForCiVerdict(options);
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail") {
      expect(verdict.message).toContain("Timed out after 5 min");
      expect(verdict.message).toContain("GitHub API error (not a pass)");
      expect(verdict.message).toContain("HTTP 502");
    }
    expect(elapsed()).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("treats network errors and malformed responses as errors, not passes", async () => {
    const { options } = harness(
      [
        () => {
          throw new Error("socket hang up");
        },
        () => json({ unexpected: true }),
      ],
      { timeoutMs: 60_000 },
    );
    const verdict = await waitForCiVerdict(options);
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail") expect(verdict.message).toContain("workflow_runs");
  });

  it("fails once the missing-run grace period ends", async () => {
    const { options, elapsed } = harness([() => json({ workflow_runs: [] })]);
    const verdict = await waitForCiVerdict(options);
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail") expect(verdict.message).toContain("gh workflow run ci.yml");
    expect(elapsed()).toBe(10 * 60_000);
  });

  it("ignores pull request runs for the SHA", async () => {
    const { options } = harness(
      [byPath(runsBody("completed", "success", "pull_request"), jobsBody("completed", "success"))],
      { missingGraceMs: 60_000, timeoutMs: 120_000 },
    );
    await expect(waitForCiVerdict(options)).resolves.toMatchObject({ kind: "fail" });
  });

  it("fails without waiting when the run completed and CI passed failed", async () => {
    const { options, elapsed } = harness([
      byPath(runsBody("completed", "failure"), jobsBody("completed", "failure")),
    ]);
    await expect(waitForCiVerdict(options)).resolves.toMatchObject({ kind: "fail" });
    expect(elapsed()).toBe(0);
  });
});

describe("parseCiVerdictArgs", () => {
  const required = ["--repo", REPO, "--sha", SHA];

  it("applies the documented defaults", () => {
    expect(parseCiVerdictArgs(required)).toEqual({
      repo: REPO,
      sha: SHA,
      workflow: "ci.yml",
      jobName: "CI passed",
      timeoutMinutes: 70,
      missingGraceMinutes: 10,
      pollSeconds: 30,
    });
  });

  it("rejects bad repositories, short SHAs, unknown flags and bad numbers", () => {
    expect(() => parseCiVerdictArgs(["--repo", "bigbud", "--sha", SHA])).toThrow("--repo");
    expect(() => parseCiVerdictArgs(["--repo", REPO, "--sha", "abc123"])).toThrow("40-hex");
    expect(() => parseCiVerdictArgs([...required, "--event", "push"])).toThrow("Unknown flag");
    expect(() => parseCiVerdictArgs([...required, "--poll-seconds", "0"])).toThrow(
      "positive integer",
    );
    expect(() =>
      parseCiVerdictArgs([...required, "--timeout-minutes", "5", "--missing-grace-minutes", "10"]),
    ).toThrow("must not exceed");
  });
});

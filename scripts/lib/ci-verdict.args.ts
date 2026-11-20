/** Argument parsing for `scripts/wait-for-ci-verdict.ts`. */

export interface CiVerdictArgs {
  readonly repo: string;
  readonly sha: string;
  readonly workflow: string;
  readonly jobName: string;
  readonly timeoutMinutes: number;
  readonly missingGraceMinutes: number;
  readonly pollSeconds: number;
}

export const CI_VERDICT_USAGE =
  "Usage: node scripts/wait-for-ci-verdict.ts --repo <owner/name> --sha <40-hex commit> " +
  '[--workflow ci.yml] [--job "CI passed"] [--timeout-minutes 70] [--missing-grace-minutes 10] ' +
  "[--poll-seconds 30]";

const DEFAULTS: Readonly<Record<string, string>> = {
  workflow: "ci.yml",
  job: "CI passed",
  "timeout-minutes": "70",
  "missing-grace-minutes": "10",
  "poll-seconds": "30",
};
const KNOWN = new Set(["repo", "sha", ...Object.keys(DEFAULTS)]);

function positive(name: string, text: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < 1) {
    throw new Error(`--${name} must be a positive integer, got '${text}'.`);
  }
  return value;
}

/** Parses `--flag value` pairs; `--repo` and `--sha` are required. */
export function parseCiVerdictArgs(argv: ReadonlyArray<string>): CiVerdictArgs {
  const values = new Map<string, string>(Object.entries(DEFAULTS));
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected '--flag value' pairs near '${flag}'.\n${CI_VERDICT_USAGE}`);
    }
    const key = flag.slice(2);
    if (!KNOWN.has(key)) throw new Error(`Unknown flag --${key}.\n${CI_VERDICT_USAGE}`);
    values.set(key, value);
  }
  const repo = values.get("repo");
  const sha = values.get("sha");
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`--repo must be <owner/name>, got '${repo ?? ""}'.\n${CI_VERDICT_USAGE}`);
  }
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`--sha must be a full 40-hex commit SHA, got '${sha ?? ""}'.`);
  }
  const timeoutMinutes = positive("timeout-minutes", values.get("timeout-minutes")!);
  const missingGraceMinutes = positive(
    "missing-grace-minutes",
    values.get("missing-grace-minutes")!,
  );
  if (missingGraceMinutes > timeoutMinutes) {
    throw new Error("--missing-grace-minutes must not exceed --timeout-minutes.");
  }
  return {
    repo,
    sha,
    workflow: values.get("workflow")!,
    jobName: values.get("job")!,
    timeoutMinutes,
    missingGraceMinutes,
    pollSeconds: positive("poll-seconds", values.get("poll-seconds")!),
  };
}

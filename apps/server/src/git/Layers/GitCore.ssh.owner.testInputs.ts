import type { ExecuteGitInput } from "../Services/GitCore.ts";

export const refusedOwnerInputs = (
  statusInput: ExecuteGitInput,
  workTreeInput: ExecuteGitInput,
): ReadonlyArray<readonly [string, ExecuteGitInput]> => [
  ["another operation label", { ...statusInput, operation: "GitCore.execute" }],
  ["status variant", { ...statusInput, args: ["status", "--short", "--branch"] }],
  ["extra args", { ...statusInput, args: [...statusInput.args, "--", "src"] }],
  ["config override", { ...statusInput, args: ["-c", "core.fsmonitor=true", ...statusInput.args] }],
  [
    "swapped numstat recipe",
    {
      ...statusInput,
      operation: "GitCore.statusDetails.stagedNumstat",
      args: ["diff", "--numstat"],
    },
  ],
  [
    "external diff flag",
    {
      ...statusInput,
      operation: "GitCore.statusDetailsLocal.unstagedNumstat",
      args: ["diff", "--numstat", "--ext-diff"],
    },
  ],
  [
    "arbitrary symbolic ref",
    {
      ...statusInput,
      operation: "GitCore.statusDetailsLocal.defaultRef",
      args: ["symbolic-ref", "HEAD"],
    },
  ],
  [
    "arbitrary remote URL",
    {
      ...statusInput,
      operation: "GitCore.originRemoteExists",
      args: ["remote", "get-url", "upstream"],
    },
  ],
  [
    "direct workspace status refresh",
    {
      ...statusInput,
      operation: "GitCore.fetchRemoteForStatus",
      args: ["--git-dir", `${statusInput.cwd}/.git`, "fetch", "--quiet", "--no-tags", "origin"],
      timeoutMs: 5_000,
    },
  ],
  [
    "path-specific numstat",
    {
      ...statusInput,
      operation: "GitCore.statusDetails.fallbackNumstat",
      args: ["diff", "--numstat", "--no-index", "/dev/null", "--", "new.txt"],
    },
  ],
  [
    "standalone upstream probe",
    {
      ...statusInput,
      operation: "GitCore.resolveCurrentUpstream",
      args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    },
  ],
  ["unported fetch", { ...statusInput, operation: "GitCore.fetch", args: ["fetch"] }],
  ["mutation", { ...statusInput, operation: "GitCore.commit", args: ["commit"] }],
  ["environment", { ...statusInput, env: { GIT_SSH_COMMAND: "other" } }],
  ["stdin", { ...statusInput, stdin: "" }],
  ["progress", { ...statusInput, progress: {} }],
  ["mutation identity", { ...statusInput, operationId: "operation-id" }],
  ["nonzero handling override", { ...statusInput, allowNonZeroExit: false }],
  ["truncation override", { ...statusInput, truncateOutputAtMaxBytes: true }],
  ["status timeout override", { ...statusInput, timeoutMs: 10 }],
  ["status output cap override", { ...statusInput, maxOutputBytes: 100 }],
  ["worktree timeout override", { ...workTreeInput, timeoutMs: 5_001 }],
  ["worktree output cap override", { ...workTreeInput, maxOutputBytes: 4_097 }],
  ["extra worktree arg", { ...workTreeInput, args: [...workTreeInput.args, "HEAD"] }],
  ["missing target", { ...statusInput, executionTargetId: undefined }],
  ["local target", { ...statusInput, executionTargetId: "local" }],
  ["invalid SSH target", { ...statusInput, executionTargetId: "ssh:" }],
  [
    "explicit agent target",
    { ...statusInput, executionTargetId: "ssh:host=example&transport=agent" },
  ],
  ["relative cwd", { ...statusInput, cwd: "srv/repo" }],
  ["NUL in cwd", { ...statusInput, cwd: "/srv/repo\0outside" }],
];

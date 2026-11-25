import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Effect, Option } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import { isSshTargetDisconnected } from "../../ssh/sshTargetDisconnects.ts";
import type { GitCoreShape, GitPushResult } from "../Services/GitCore.ts";
import {
  InitiatingGitOwner,
  type ApprovedInitiatingGitPush,
  type InitiatingGitDestination,
  type InitiatingGitOwnerShape,
  type InitiatingGitPushDestination,
} from "../Services/InitiatingGitOwner.ts";
import { DEFAULT_TIMEOUT_MS } from "./GitCoreExecutor.ts";

const OPERATION = "GitCore.pushCurrentBranch.initiatingOwner";

/** Support only unambiguous explicit SSH URLs in this slice, not aliases in SCP form or helpers. */
function parseDestination(url: string): InitiatingGitDestination | undefined {
  const match =
    /^ssh:\/\/([a-zA-Z0-9_][a-zA-Z0-9_.-]*)@([a-zA-Z0-9][a-zA-Z0-9.-]*)(?::([1-9][0-9]{0,4}))?(\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)$/u.exec(
      url,
    );
  if (!match || match[0] !== url) return undefined;
  const [, user, host, portText, repositoryPath] = match;
  if (
    !user ||
    !host ||
    !repositoryPath ||
    repositoryPath.split("/").some((part) => part === "." || part === "..")
  ) {
    return undefined;
  }
  const port = Number(portText ?? 22);
  return port <= 65535 ? { user, host, port, repositoryPath } : undefined;
}

function isAvailableTarget(destination: InitiatingGitPushDestination): boolean {
  const target = parseSshExecutionTarget(destination.executionTargetId);
  return (
    !!destination.targetGeneration &&
    !!target &&
    destination.host === target.host &&
    destination.user === target.user &&
    destination.port === Number(target.port ?? 22) &&
    !isSshTargetDisconnected(destination.executionTargetId)
  );
}

function approveDestinations(
  approval: ApprovedInitiatingGitPush,
): readonly [InitiatingGitPushDestination, ...InitiatingGitPushDestination[]] | undefined {
  const scopes = approval.destinations ?? [
    {
      // There is no exact URL in the old grant. Accept only its deterministic spelling;
      // equivalent spellings or a sibling URL require a new complete-list grant.
      effectiveUrl: `ssh://${approval.destination.user}@${approval.destination.host}${approval.destination.port === 22 ? "" : `:${approval.destination.port}`}${approval.destination.repositoryPath}`,
      executionTargetId: approval.executionTargetId,
      targetGeneration: approval.targetGeneration,
    },
  ];
  const destinations: InitiatingGitPushDestination[] = [];
  for (const { effectiveUrl, executionTargetId, targetGeneration } of scopes) {
    const parsed = parseDestination(effectiveUrl);
    if (!parsed) return undefined;
    if (approval.destinations === undefined) {
      const { host, user, port, repositoryPath } = approval.destination;
      if (
        parsed.host !== host ||
        parsed.user !== user ||
        parsed.port !== port ||
        parsed.repositoryPath !== repositoryPath
      ) {
        return undefined;
      }
    }
    const destination = { ...parsed, effectiveUrl, executionTargetId, targetGeneration };
    if (!isAvailableTarget(destination)) return undefined;
    destinations.push(destination);
  }
  const [first, ...rest] = destinations;
  return first ? [first, ...rest] : undefined;
}

export const pushInitiatingBranch = Effect.fn("pushInitiatingBranch")(function* (
  execute: GitCoreShape["execute"],
  cwd: string,
  legacy: () => Effect.Effect<GitPushResult, GitCommandError>,
) {
  const selection = yield* Effect.serviceOption(InitiatingGitOwner);
  return yield* Option.isSome(selection)
    ? pushSelectedInitiatingBranch(execute, cwd, selection.value)
    : legacy();
});

/** The selected path has no legacy callback, including when the selected owner is absent. */
export const pushSelectedInitiatingBranch = Effect.fn("pushSelectedInitiatingBranch")(function* (
  execute: GitCoreShape["execute"],
  cwd: string,
  { owner, approvedPush: approval }: InitiatingGitOwnerShape,
) {
  const deny = (detail: string) =>
    new GitCommandError({ operation: OPERATION, command: "push", cwd, detail });
  if (!owner || !approval || approval.direction !== "push") {
    return yield* deny(
      "Initiating Git push selected without an available owner and approved push scope.",
    );
  }
  const destinations = approveDestinations(approval);
  if (!destinations) {
    return yield* deny("An approved SSH push destination or target is invalid or disconnected.");
  }
  const { remoteName } = approval;
  const repository = {
    worktree: approval.repository.worktree,
    gitDir: approval.repository.gitDir,
    commonDir: approval.repository.commonDir,
  };
  const refs = { source: approval.refs.source, destination: approval.refs.destination };

  // No status refresh on the selected lane. These probes inspect local refs/config only.
  const probe = (args: ReadonlyArray<string>) =>
    execute({
      operation: OPERATION,
      cwd,
      args: ["--no-lazy-fetch", ...args],
      allowNonZeroExit: true,
    }).pipe(Effect.mapError(() => deny("Could not inspect the selected Git push.")));
  const stdout = (args: ReadonlyArray<string>) =>
    probe(args).pipe(
      Effect.flatMap((result) =>
        result.code === 0 && !result.stdoutTruncated && !result.stderrTruncated
          ? Effect.succeed(
              result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout,
            )
          : Effect.fail(deny("Could not resolve the selected Git push.")),
      ),
    );
  const config = (key: string, asBoolean = false) =>
    probe(["config", "--null", ...(asBoolean ? ["--type=bool"] : []), "--get-all", key]).pipe(
      Effect.flatMap((result) => {
        if (!result.stdoutTruncated && !result.stderrTruncated) {
          if (result.code === 0 && result.stdout.endsWith("\0")) {
            return Effect.succeed(result.stdout.slice(0, -1).split("\0"));
          }
          if (result.code === 1 && !result.stdout && !result.stderr) return Effect.succeed([]);
        }
        return Effect.fail(deny("Could not resolve the selected Git configuration."));
      }),
    );

  const paths = (yield* stdout([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir",
  ])).split(/\r?\n/u);
  if (paths.length !== 3 || !paths.every(isAbsolute)) {
    return yield* deny("Could not identify the selected Git worktree and repository.");
  }
  const canonicalPaths = yield* Effect.tryPromise({
    try: () => Promise.all(paths.map((path) => realpath(path))),
    catch: () => deny("Could not identify the selected Git worktree and repository."),
  });
  if (
    canonicalPaths[0] !== repository.worktree ||
    canonicalPaths[1] !== repository.gitDir ||
    canonicalPaths[2] !== repository.commonDir
  ) {
    return yield* deny("The Git repository does not match the approved push scope.");
  }

  const source = yield* stdout(["symbolic-ref", "--quiet", "HEAD"]);
  if (
    source !== refs.source ||
    !source.startsWith("refs/heads/") ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/u.test(remoteName)
  ) {
    return yield* deny("The source ref or remote is not approved for this Git push.");
  }
  const branch = source.slice("refs/heads/".length);
  const trackingRemotes = yield* config(`branch.${branch}.remote`);
  const trackingRefs = yield* config(`branch.${branch}.merge`);
  if (
    trackingRemotes.length !== 1 ||
    trackingRemotes[0] !== remoteName ||
    trackingRefs.length !== 1 ||
    trackingRefs[0] !== refs.destination ||
    !refs.destination.startsWith("refs/heads/")
  ) {
    return yield* deny(
      "The tracked remote/ref is unknown or does not match the approved push scope.",
    );
  }
  yield* stdout(["check-ref-format", refs.destination]);
  const upstream = yield* stdout([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream !== `${remoteName}/${refs.destination.slice("refs/heads/".length)}`) {
    return yield* deny("The Git push requires an unambiguous upstream tracking ref.");
  }
  const sourceOid = yield* stdout(["rev-parse", "--verify", "HEAD"]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceOid)) {
    return yield* deny("Could not resolve the approved source ref to an object ID.");
  }

  const expectedUrls = destinations.map(({ effectiveUrl }) => effectiveUrl).join("\n") + "\n";
  const requireApprovedUrls = Effect.fn("requireApprovedInitiatingPushUrls")(function* () {
    // get-url is line-delimited, not NUL-delimited. Check the inputs under NUL framing
    // first so one multiline URL/rewrite cannot masquerade as multiple approved URLs.
    const configured = yield* probe([
      "config",
      "--null",
      "--get-regexp",
      `^(remote\\.${remoteName.replaceAll(".", "\\.")}\\.(url|pushurl)|url\\..*\\.(insteadof|pushinsteadof))$`,
    ]);
    const entries = configured.stdout.slice(0, -1).split("\0");
    if (
      configured.code !== 0 ||
      configured.stdoutTruncated ||
      configured.stderrTruncated ||
      !configured.stdout.endsWith("\0") ||
      entries.some((entry) => entry.includes("\r") || entry.split("\n").length !== 2) ||
      !entries.some(
        (entry) =>
          entry.startsWith(`remote.${remoteName}.url\n`) ||
          entry.startsWith(`remote.${remoteName}.pushurl\n`),
      )
    ) {
      return yield* deny("Could not unambiguously inspect the configured Git push URLs.");
    }
    const effective = yield* probe(["remote", "get-url", "--push", "--all", "--", remoteName]);
    if (
      effective.code !== 0 ||
      effective.stdoutTruncated ||
      effective.stderrTruncated ||
      effective.stdout !== expectedUrls
    ) {
      return yield* deny(
        "The Git push does not match the complete approved effective SSH URL list.",
      );
    }
  });
  yield* requireApprovedUrls();
  for (const key of [`remote.${remoteName}.mirror`, "push.followTags"]) {
    const values = yield* config(key, true);
    if (values.length > 1 || values.some((value) => value !== "false")) {
      return yield* deny("The selected Git push may update refs outside the approved scope.");
    }
  }

  // Recheck the whole list after the local push guards, before calling the owner once.
  // The owner still has to bind and revalidate dispatch; these probes don't fence native Git.
  yield* requireApprovedUrls();
  if (!destinations.every(isAvailableTarget)) {
    return yield* deny("An approved SSH push destination or target is invalid or disconnected.");
  }

  const outcome = yield* Effect.tryPromise({
    try: (signal) =>
      owner.push(
        { direction: "push", repository, remoteName, destinations, refs, sourceOid },
        signal,
      ),
    catch: () =>
      deny("The selected Git push outcome is unknown. Verify the remote state before retrying."),
  }).pipe(
    Effect.timeoutOrElse({
      duration: DEFAULT_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          deny("The selected Git push timed out. Verify the remote state before retrying."),
        ),
    }),
  );
  if (outcome === "denied") return yield* deny("The owner denied the selected Git push.");
  if (outcome === "rejectedRef") return yield* deny("The selected Git push ref was rejected.");
  if (outcome === "partial") {
    return yield* deny(
      "The selected Git push was partial. Verify the remote state before retrying.",
    );
  }
  if (outcome !== "pushed" && outcome !== "upToDate") {
    return yield* deny(
      "The selected Git push outcome is unknown. Verify the remote state before retrying.",
    );
  }
  return {
    status: outcome === "pushed" ? "pushed" : "skipped_up_to_date",
    branch,
    upstreamBranch: upstream,
    setUpstream: false,
  } satisfies GitPushResult;
});

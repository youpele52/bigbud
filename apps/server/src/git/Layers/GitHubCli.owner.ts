import { ServiceMap } from "effect";
import { GitHubCliError } from "@bigbud/contracts";

import {
  initiatingTransportUnavailable,
  type InitiatingGitVerb,
} from "./GitCore.initiatingTransport.ts";

export interface GitHubCliOwnerResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface GitHubCliOwnerTransportShape {
  readonly execute: (
    input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs: number;
    },
    signal: AbortSignal,
  ) => Promise<GitHubCliOwnerResult>;
}

/** The owner decides the executable and environment; TypeScript passes only validated argv. */
export class GitHubCliOwnerTransport extends ServiceMap.Service<
  GitHubCliOwnerTransport,
  GitHubCliOwnerTransportShape
>()("bigbud/git/GitHubCliOwnerTransport") {}

// API-intent verbs plus the owner-shimmed `pr checkout`. Everything else stays refused.
export function isOwnerAdmittedGitHubCliCommand(args: ReadonlyArray<string>): boolean {
  const [command, subcommand] = args;
  if (command === "pr")
    return (
      subcommand === "list" ||
      subcommand === "view" ||
      subcommand === "create" ||
      subcommand === "checkout"
    );
  if (command === "repo") return subcommand === "view";
  return false;
}

export function requiresOwnerSshTransport(args: ReadonlyArray<string>): boolean {
  return args[0] === "pr" && args[1] === "checkout";
}

function verbForArgs(args: ReadonlyArray<string>): InitiatingGitVerb {
  return requiresOwnerSshTransport(args) ? "checkoutPullRequest" : "gh";
}

export function githubCliOwnerDenied(args: ReadonlyArray<string>, cwd: string): GitHubCliError {
  const transport = initiatingTransportUnavailable(verbForArgs(args), cwd);
  return new GitHubCliError({ operation: "execute", detail: transport.detail });
}

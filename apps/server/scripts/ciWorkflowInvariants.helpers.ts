/** Shared types and readers for the CI workflow invariant tests (`ciWorkflowInvariants*.test.ts`). */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
  readonly "continue-on-error"?: unknown;
}
export interface Job {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly uses?: string;
  readonly "runs-on"?: string;
  readonly "timeout-minutes"?: unknown;
  readonly "continue-on-error"?: unknown;
  readonly concurrency?: unknown;
  readonly strategy?: {
    readonly "fail-fast"?: boolean;
    readonly matrix?: Record<string, unknown>;
  };
  readonly steps?: readonly Step[];
}
export interface Workflow {
  readonly on: Record<string, unknown>;
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": string };
  readonly jobs: Record<string, Job>;
}
export interface CompositeAction {
  readonly inputs: Record<string, { readonly default?: string }>;
  readonly runs: { readonly using: string; readonly steps: readonly Step[] };
}

export const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);
export const workflowPath = (file: string) => `.github/workflows/${file}`;
export const actionPath = (name: string) => `.github/actions/${name}/action.yml`;
export const readText = (path: string) => readFileSync(repoFile(path), "utf8");
export const readWorkflow = (file: string) => parse(readText(workflowPath(file))) as Workflow;
export const readAction = (name: string) => parse(readText(actionPath(name))) as CompositeAction;
export const readPackageScripts = (path: string) =>
  (JSON.parse(readText(path)) as { readonly scripts: Record<string, string> }).scripts;

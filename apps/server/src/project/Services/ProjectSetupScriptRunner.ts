import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { TerminalRetrySetupInput } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type { TerminalEvictTarget } from "@bigbud/contracts/workspace/terminal.limit.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
  /** At the live terminal limit, close this pane first (a confirmed retry). */
  readonly evict?: TerminalEvictTarget;
}

export interface ProjectSetupScriptRunnerShape {
  readonly runForThread: (
    input: ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<ProjectSetupScriptRunnerResult, Error>;
  /**
   * "Close oldest and run setup": reruns a setup the live limit refused, with its stored
   * inputs, or with inputs re-derived from the thread when none are stored.
   */
  readonly retryBlockedSetup?: (
    input: TerminalRetrySetupInput,
  ) => Effect.Effect<ProjectSetupScriptRunnerResult, Error>;
}

export class ProjectSetupScriptRunner extends ServiceMap.Service<
  ProjectSetupScriptRunner,
  ProjectSetupScriptRunnerShape
>()("t3/project/ProjectSetupScriptRunner") {}

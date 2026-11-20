import { Effect, Option } from "effect";
import { Argument, Flag } from "effect/unstable/cli";

import {
  RemoteAgentBackendUnavailableError,
  resolveRemoteAgentControlSocket,
} from "../remote-agent/remoteAgentLocalControl.client.ts";
import {
  REMOTE_AGENT_CLI_EXIT,
  type RemoteAgentControlResponse,
} from "../remote-agent/remoteAgentLocalControl.protocol.ts";
import {
  operationRecovery,
  RemoteAgentOperationUncertainError,
} from "./cli.remoteAgent.recovery.ts";

import { version } from "../../package.json" with { type: "json" };

/** Arguments, output and exit-code handling shared by every `bigbud remote-agent` command. */
export const targetArgument = Argument.string("target").pipe(
  Argument.withDescription("Saved remote target ID or SSH host alias (host or user@host)."),
);
export const sharedFlags = {
  json: Flag.boolean("json").pipe(Flag.withDescription("Print JSON."), Flag.optional),
  baseDir: Flag.string("base-dir").pipe(
    Flag.withDescription("bigbud base directory (defaults to BIGBUD_HOME or ~/.bigbud)."),
    Flag.optional,
  ),
  dev: Flag.boolean("dev").pipe(
    Flag.withDescription("Talk to the development backend instead of the installed app."),
    Flag.optional,
  ),
};

export interface SharedOptions {
  readonly json: Option.Option<boolean>;
  readonly baseDir: Option.Option<string>;
  readonly dev: Option.Option<boolean>;
}

export function socketFor(options: SharedOptions): string {
  return resolveRemoteAgentControlSocket({
    baseDir: Option.getOrUndefined(options.baseDir),
    version,
    development: Option.getOrElse(options.dev, () => false),
  });
}

export function print(json: boolean, value: unknown, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

export function failResponse(json: boolean, response: RemoteAgentControlResponse): number {
  if (response.ok) return REMOTE_AGENT_CLI_EXIT.failed;
  print(json, response, `bigbud remote-agent: ${response.error.message}`);
  // Exit 6 is reserved for an unreachable local backend (thrown by the client).
  return REMOTE_AGENT_CLI_EXIT.failed;
}

/** Run one CLI action, mapping backend unavailability to its dedicated exit code. */
export function runAction(options: SharedOptions, action: (json: boolean) => Promise<number>) {
  const json = Option.getOrElse(options.json, () => false);
  return Effect.promise(() =>
    action(json).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "Request failed.";
      const recovery =
        cause instanceof RemoteAgentOperationUncertainError
          ? operationRecovery(cause.operationId, cause.target)
          : undefined;
      print(
        json,
        { ok: false, ...recovery, error: { message } },
        `bigbud remote-agent: ${message}${recovery ? `\n${recovery.recovery}` : ""}`,
      );
      return cause instanceof RemoteAgentBackendUnavailableError
        ? REMOTE_AGENT_CLI_EXIT.backendUnavailable
        : REMOTE_AGENT_CLI_EXIT.uncertain;
    }),
  ).pipe(Effect.map((code) => void (process.exitCode = code)));
}

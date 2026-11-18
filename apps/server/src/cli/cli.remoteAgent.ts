import { randomUUID } from "node:crypto";
import {
  followRemoteAgentOperation,
  operationRecovery,
  RemoteAgentOperationUncertainError,
} from "./cli.remoteAgent.recovery.ts";
import {
  askYesNo,
  capacityHint,
  REPLACE_FLAG_CONFLICT,
  resolveReplaceChoice,
} from "./cli.remoteAgent.replace.ts";

import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  RemoteAgentBackendUnavailableError,
  resolveRemoteAgentControlSocket,
  sendRemoteAgentControlRequest,
} from "../remote-agent/remoteAgentLocalControl.client.ts";
import {
  isRemoteAgentOperationSnapshot,
  REMOTE_AGENT_CLI_EXIT,
  type RemoteAgentControlRequest,
  type RemoteAgentControlResponse,
} from "../remote-agent/remoteAgentLocalControl.protocol.ts";

import { version } from "../../package.json" with { type: "json" };

const targetArgument = Argument.string("target").pipe(
  Argument.withDescription("Saved remote target ID or SSH host alias (host or user@host)."),
);
const sharedFlags = {
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

interface SharedOptions {
  readonly json: Option.Option<boolean>;
  readonly baseDir: Option.Option<string>;
  readonly dev: Option.Option<boolean>;
}

function socketFor(options: SharedOptions): string {
  return resolveRemoteAgentControlSocket({
    baseDir: Option.getOrUndefined(options.baseDir),
    version,
    development: Option.getOrElse(options.dev, () => false),
  });
}

function print(json: boolean, value: unknown, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

function failResponse(json: boolean, response: RemoteAgentControlResponse): number {
  if (response.ok) return REMOTE_AGENT_CLI_EXIT.failed;
  print(json, response, `bigbud remote-agent: ${response.error.message}`);
  // Exit 6 is reserved for an unreachable local backend (thrown by the client).
  return REMOTE_AGENT_CLI_EXIT.failed;
}

function askConsent(target: string, message: string): Promise<boolean> {
  return askYesNo(`${message}\nInstall it on ${target}? [y/N] `);
}

/** Run one CLI action, mapping backend unavailability to its dedicated exit code. */
function runAction(options: SharedOptions, action: (json: boolean) => Promise<number>) {
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

const readOnlyCommand = (method: "status" | "doctor", description: string) =>
  Command.make(method, { target: targetArgument, ...sharedFlags }).pipe(
    Command.withDescription(description),
    Command.withHandler((options) =>
      runAction(options, async (json) => {
        const response = await sendRemoteAgentControlRequest(
          socketFor(options),
          { method, target: options.target },
          120_000,
        );
        if (!response.ok) return failResponse(json, response);
        print(json, response.result, JSON.stringify(response.result, null, 2));
        return REMOTE_AGENT_CLI_EXIT.active;
      }),
    ),
  );

const installCommand = Command.make("install", {
  target: targetArgument,
  replace: Flag.boolean("replace").pipe(
    Flag.withDescription("Retire older builds after the new build is active, without asking."),
    Flag.optional,
  ),
  keepPrevious: Flag.boolean("keep-previous").pipe(
    Flag.withDescription(
      "Keep older builds without asking (the default when not interactive or with --json).",
    ),
    Flag.optional,
  ),
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription("Consent to installing on a host not yet approved in bigbud."),
    Flag.optional,
  ),
  ...sharedFlags,
}).pipe(
  Command.withDescription(
    "Install the bigbud remote agent and activate it. When an older build is installed, asks whether to replace it (interactive only); --replace or --keep-previous answers without asking.",
  ),
  Command.withHandler((options) =>
    runAction(options, async (json) => {
      const replaceFlag = Option.getOrElse(options.replace, () => false);
      const keepPrevious = Option.getOrElse(options.keepPrevious, () => false);
      if (replaceFlag && keepPrevious) {
        print(
          json,
          { ok: false, error: { code: "usage", message: REPLACE_FLAG_CONFLICT } },
          `bigbud remote-agent: ${REPLACE_FLAG_CONFLICT}`,
        );
        return REMOTE_AGENT_CLI_EXIT.failed;
      }
      const socketPath = socketFor(options);
      // Read-only status first: the replace question needs an approved host with an older build.
      const replace = await resolveReplaceChoice({
        socketPath,
        target: options.target,
        replace: replaceFlag,
        keepPrevious,
        json,
        agentVersion: version,
        hint: (line) => void process.stderr.write(`${line}\n`),
      });
      const operationId = randomUUID();
      const request = (consent: boolean): RemoteAgentControlRequest => ({
        method: "install",
        operationId,
        target: options.target,
        replace,
        consent,
      });
      let response = await sendRemoteAgentControlRequest(
        socketPath,
        request(Option.getOrElse(options.yes, () => false)),
        120_000,
      ).catch((cause: unknown) => {
        if (cause instanceof RemoteAgentBackendUnavailableError) throw cause;
        throw new RemoteAgentOperationUncertainError(operationId, options.target, cause);
      });
      if (!response.ok) return failResponse(json, response);
      const accepted = response.result as { status?: string; message?: string };
      if (accepted.status === "consent-required") {
        if (json || !(await askConsent(options.target, accepted.message ?? ""))) {
          print(json, accepted, `${accepted.message}\nRerun with --yes to consent.`);
          return REMOTE_AGENT_CLI_EXIT.consentRequired;
        }
        response = await sendRemoteAgentControlRequest(socketPath, request(true), 120_000).catch(
          (cause: unknown) => {
            throw new RemoteAgentOperationUncertainError(operationId, options.target, cause);
          },
        );
        if (!response.ok) return failResponse(json, response);
      }
      if (!isRemoteAgentOperationSnapshot(response.result))
        throw new RemoteAgentOperationUncertainError(
          operationId,
          options.target,
          new Error("Invalid acceptance reply."),
        );
      if (!json) process.stderr.write(`Operation ${response.result.operationId} started.\n`);
      return followRemoteAgentOperation({
        socketPath,
        operationId: response.result.operationId,
        target: options.target,
        print: (value, text) => print(json, value, text),
        hint: (snapshot) => capacityHint(snapshot, replace),
      });
    }),
  ),
);

export const remoteAgentCommand = Command.make("remote-agent").pipe(
  Command.withDescription(
    "Install or inspect the bigbud remote agent through the running bigbud backend.",
  ),
  Command.withSubcommands([
    readOnlyCommand("status", "Show the agent status of a remote target."),
    readOnlyCommand("doctor", "Read-only platform and prerequisite report for a remote target."),
    installCommand,
    Command.make("follow", { operationId: Argument.string("operationId"), ...sharedFlags }).pipe(
      Command.withDescription(
        "Read an existing install operation without starting another install.",
      ),
      Command.withHandler((options) =>
        runAction(options, (json) =>
          followRemoteAgentOperation({
            socketPath: socketFor(options),
            operationId: options.operationId,
            print: (value, text) => print(json, value, text),
          }),
        ),
      ),
    ),
  ]),
);

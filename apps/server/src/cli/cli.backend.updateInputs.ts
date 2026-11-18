/**
 * `bigbud backend update-inputs set`: writes the owner-private development inputs that a managed
 * backend's `local-graph` runtime updates read (`runtimeUpdate.devInputs.ts`). Development only;
 * refused in release builds. The file is never replaced: remove it deliberately first.
 */
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import { parseRemoteAgentInstallSource } from "../remote-agent/remoteAgentInstallManager.ts";
import { developmentGraphOverridesAllowed } from "../remote-backend/developmentOverrides.ts";
import { readLocalSupervisorServiceFile } from "../remote-backend/localSupervisorService.files.ts";
import { publishServiceFile } from "../remote-backend/localSupervisorService.setup.files.ts";
import {
  decodeRuntimeUpdateDevInputs,
  encodeRuntimeUpdateDevInputs,
  runtimeUpdateDevInputsPath,
} from "../remote-backend/runtimeUpdate.devInputs.ts";

export interface UpdateInputsSetInput {
  readonly authorityId: string;
  readonly graphVersionsDirectory: string;
  readonly trustedKeys: Option.Option<string>;
  readonly installSource: Option.Option<string>;
}

const readPrivateJson = async (path: string) =>
  JSON.parse(await readLocalSupervisorServiceFile(resolve(path), 64 * 1024)) as unknown;

/** Validates everything the backend reader validates, then publishes the file once (0600). */
export async function setRuntimeUpdateDevInputs(
  input: UpdateInputsSetInput,
  options: { readonly homeDir?: string; readonly environment?: NodeJS.ProcessEnv } = {},
) {
  if (!developmentGraphOverridesAllowed(options.environment ?? process.env))
    throw new Error("development inputs are refused in release builds");
  const graphVersionsDirectory = await fs.realpath(resolve(input.graphVersionsDirectory));
  if (!(await fs.stat(graphVersionsDirectory)).isDirectory())
    throw new Error("the graph versions directory is not a directory");
  const trustedKeys = Option.isSome(input.trustedKeys)
    ? await readPrivateJson(input.trustedKeys.value)
    : undefined;
  let installSourcePath: string | undefined;
  if (Option.isSome(input.installSource)) {
    installSourcePath = await fs.realpath(resolve(input.installSource.value));
    parseRemoteAgentInstallSource(await readPrivateJson(installSourcePath));
  }
  const text = encodeRuntimeUpdateDevInputs(
    decodeRuntimeUpdateDevInputs(
      JSON.stringify({
        schemaVersion: 1,
        graphVersionsDirectory,
        ...(trustedKeys ? { trustedKeys } : {}),
        ...(installSourcePath ? { installSourcePath } : {}),
      }),
    ),
  );
  const path = runtimeUpdateDevInputsPath(
    await fs.realpath(options.homeDir ?? homedir()),
    input.authorityId,
  );
  await publishServiceFile(path, text, async () => {});
  return { path };
}

export const backendUpdateInputsCommand = Command.make("update-inputs").pipe(
  Command.withDescription(
    "Manage this account's owner-private development inputs for local-graph runtime updates.",
  ),
  Command.withSubcommands([
    Command.make("set", {
      authorityId: Flag.string("authority").pipe(Flag.withSchema(RemoteBackendAuthorityId)),
      graphVersionsDirectory: Flag.string("graph-versions-dir").pipe(
        Flag.withDescription("Directory holding one producer output directory per version."),
      ),
      trustedKeys: Flag.string("trusted-keys").pipe(
        Flag.optional,
        Flag.withDescription("Owner-private JSON map of extra pinned Ed25519 public keys."),
      ),
      installSource: Flag.string("install-source").pipe(
        Flag.optional,
        Flag.withDescription("Owner-private signed Rust install source JSON."),
      ),
    }).pipe(
      Command.withDescription(
        "Write the inputs file once (never replaced). Each local-graph update reads it.",
      ),
      Command.withHandler((input) =>
        Effect.promise(async () => {
          try {
            const result = await setRuntimeUpdateDevInputs(input);
            process.stdout.write(`Wrote ${result.path}\n`);
          } catch (cause) {
            const reason =
              (cause as NodeJS.ErrnoException)?.code === "EEXIST"
                ? "inputs file already exists; remove it first"
                : cause instanceof Error && /release builds|not a directory/.test(cause.message)
                  ? cause.message
                  : "unsafe or unreadable input";
            process.stderr.write(`bigbud backend: Update inputs refused: ${reason}.\n`);
            process.exitCode = 1;
          }
        }),
      ),
    ),
  ]),
);

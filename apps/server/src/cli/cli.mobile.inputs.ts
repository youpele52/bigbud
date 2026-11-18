import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import { verifyMobileOptionalArtifactBytes } from "@bigbud/shared/mobileOptionalArtifact";
import { mobileRegistryReleaseId } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { readLocalSupervisorServiceFile } from "../remote-backend/localSupervisorService.files.ts";
import { publishServiceFile } from "../remote-backend/localSupervisorService.setup.files.ts";
import {
  decodeMobileNativeInputs,
  encodeMobileNativeInputs,
  MOBILE_NATIVE_INPUTS_FILE,
  MobileNativeInputsRefusal,
} from "../remote-backend/mobileGatewayActivation.inputs.decode.ts";
import {
  assertMobileNativeArtifactFile,
  mobileNativeInputsDirectory,
} from "../remote-backend/mobileGatewayActivation.inputs.read.ts";

export interface MobileInputsSetInput {
  readonly authorityId: string;
  readonly trustedKeys: string;
  readonly gateway: string;
  readonly gatewayFile: string;
  readonly assets: string;
  readonly assetsFile: string;
  readonly stageId: Option.Option<string>;
}
const readJson = async (path: string) =>
  JSON.parse(await readLocalSupervisorServiceFile(resolve(path), 64 * 1024)) as unknown;

/**
 * Builds the owner-private inputs file from owner-private JSON inputs (0600, like `backend setup
 * --trusted-keys`) and verifies everything the backend reader verifies, plus the artifact bytes.
 * Publication is atomic and never replaces an existing file: remove it deliberately first.
 */
export async function setMobileNativeInputs(input: MobileInputsSetInput, homeDir = homedir()) {
  const root = mobileNativeInputsDirectory(await fs.realpath(homeDir), input.authorityId);
  const [trustedKeys, gateway, assets] = await Promise.all(
    [input.trustedKeys, input.gateway, input.assets].map(readJson),
  );
  const draft = (stageId: string) =>
    encodeMobileNativeInputs({
      trustedKeys: trustedKeys as Record<string, string>,
      artifacts: {
        stageId,
        gateway,
        assets,
        gatewayPath: resolve(input.gatewayFile),
        assetsPath: resolve(input.assetsFile),
      },
    });
  // Decode once to learn the verified pair, then fix the stage id (default: the release id).
  const probe = decodeMobileNativeInputs(draft(Option.getOrElse(input.stageId, () => "probe")));
  const stageId = Option.getOrElse(input.stageId, () =>
    mobileRegistryReleaseId(probe.gateway, probe.assets),
  );
  const text = draft(stageId);
  const {
    value,
    gateway: verifiedGateway,
    assets: verifiedAssets,
  } = decodeMobileNativeInputs(text);
  for (const [path, artifact] of [
    [value.artifacts.gatewayPath, verifiedGateway],
    [value.artifacts.assetsPath, verifiedAssets],
  ] as const) {
    await assertMobileNativeArtifactFile(path, artifact.sizeBytes);
    try {
      verifyMobileOptionalArtifactBytes(artifact, await fs.readFile(path));
    } catch {
      throw new MobileNativeInputsRefusal("unsafe-artifact-file");
    }
  }
  const path = join(root, MOBILE_NATIVE_INPUTS_FILE);
  await publishServiceFile(path, text, async () => {});
  return { path, stageId };
}

export const mobileInputsCommand = Command.make("inputs").pipe(
  Command.withDescription("Manage this account's owner-private mobile proof inputs."),
  Command.withSubcommands([
    Command.make("set", {
      authorityId: Flag.string("authority").pipe(Flag.withSchema(RemoteBackendAuthorityId)),
      trustedKeys: Flag.string("trusted-keys").pipe(
        Flag.withDescription("Owner-private JSON map of pinned Ed25519 public keys."),
      ),
      gateway: Flag.string("gateway").pipe(
        Flag.withDescription("Owner-private signed mobile-gateway descriptor JSON."),
      ),
      gatewayFile: Flag.string("gateway-file").pipe(
        Flag.withDescription("Local gateway executable whose bytes the descriptor signs."),
      ),
      assets: Flag.string("assets").pipe(
        Flag.withDescription("Owner-private signed mobile-assets descriptor JSON."),
      ),
      assetsFile: Flag.string("assets-file").pipe(
        Flag.withDescription("Local assets archive whose bytes the descriptor signs."),
      ),
      stageId: Flag.string("stage-id").pipe(
        Flag.optional,
        Flag.withDescription("Optional stage id; defaults to the signed release id."),
      ),
    }).pipe(
      Command.withDescription(
        "Write the inputs file once (never replaced). The backend reads it on its next start.",
      ),
      Command.withHandler((input) =>
        Effect.promise(async () => {
          try {
            const result = await setMobileNativeInputs(input);
            process.stdout.write(
              `Wrote ${result.path}\nStage: ${result.stageId}\nRestart the backend to load the inputs.\n`,
            );
          } catch (cause) {
            const reason =
              cause instanceof MobileNativeInputsRefusal
                ? cause.reason
                : (cause as NodeJS.ErrnoException)?.code === "EEXIST"
                  ? "inputs file already exists; remove it first"
                  : "unsafe or unreadable input";
            process.stderr.write(`bigbud mobile: Inputs refused: ${reason}.\n`);
            process.exitCode = 1;
          }
        }),
      ),
    ),
  ]),
);

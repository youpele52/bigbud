import { isAbsolute, normalize } from "node:path";
import * as Schema from "effect/Schema";
import {
  parseMobileOptionalArtifact,
  verifyMobileOptionalArtifactSignature,
} from "@bigbud/shared/mobileOptionalArtifact";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { decodeBackendSetupTrust } from "../cli/cli.backend.inputs.ts";
import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";
import type { RemoteMobileNativeInputsValue } from "./mobileGatewayActivation.inputs.ts";

/** Owner-private inputs file, next to `config-v1` and `client-token` (decision D-A). */
export const MOBILE_NATIVE_INPUTS_FILE = "mobile-inputs-v1";
export const MOBILE_NATIVE_INPUTS_MAX_BYTES = 256 * 1024;

const Token = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/));
const ArtifactPath = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(4096));
const InputsFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  trustedKeys: Schema.Record(Schema.String, Schema.String),
  stageId: Token,
  gateway: Schema.Unknown,
  assets: Schema.Unknown,
  gatewayPath: ArtifactPath,
  assetsPath: ArtifactPath,
});

/** A refusal with a short, non-secret reason category safe to show in owner status. */
export class MobileNativeInputsRefusal extends Error {
  constructor(readonly reason: MobileNativeInputsReason) {
    super(`Mobile proof inputs refused: ${reason}.`);
  }
}
export type MobileNativeInputsReason =
  | "unsafe-directory"
  | "unsafe-file"
  | "malformed"
  | "untrusted-keys"
  | "unsigned-artifacts"
  | "unsafe-artifact-file";

function refuse<A>(reason: MobileNativeInputsReason, run: () => A): A {
  try {
    return run();
  } catch (cause) {
    if (cause instanceof MobileNativeInputsRefusal) throw cause;
    throw new MobileNativeInputsRefusal(reason);
  }
}
function artifactPath(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || hasLocalSupervisorServiceControls(path))
    throw new MobileNativeInputsRefusal("malformed");
  return path;
}

/**
 * Strict decode of the inputs JSON text: exact fields, pinned Ed25519 keys, and one signed,
 * distinct, same-release gateway/assets pair verified against exactly those keys. This is the same
 * signature and pair check the publication path applies; byte hashes are verified at publication.
 */
export function decodeMobileNativeInputs(text: string): {
  readonly value: RemoteMobileNativeInputsValue;
  readonly gateway: MobileOptionalArtifact;
  readonly assets: MobileOptionalArtifact;
} {
  const file = refuse("malformed", () =>
    Schema.decodeUnknownSync(InputsFile)(JSON.parse(text), { onExcessProperty: "error" }),
  );
  const trustedKeys = refuse("untrusted-keys", () => decodeBackendSetupTrust(file.trustedKeys));
  const [gateway, assets] = refuse("unsigned-artifacts", () => {
    const pair = [
      parseMobileOptionalArtifact(file.gateway),
      parseMobileOptionalArtifact(file.assets),
    ] as const;
    if (
      pair[0].kind !== "mobile-gateway" ||
      pair[1].kind !== "mobile-assets" ||
      JSON.stringify(pair[0].compatibility) !== JSON.stringify(pair[1].compatibility)
    )
      throw Error("Exact compatible pair required.");
    for (const artifact of pair) verifyMobileOptionalArtifactSignature(artifact, trustedKeys);
    return pair;
  });
  const gatewayPath = artifactPath(file.gatewayPath);
  const assetsPath = artifactPath(file.assetsPath);
  if (gatewayPath === assetsPath) throw new MobileNativeInputsRefusal("malformed");
  const value: RemoteMobileNativeInputsValue = Object.freeze({
    trustedKeys,
    artifacts: Object.freeze({
      stageId: file.stageId,
      gateway: Object.freeze(gateway),
      assets: Object.freeze(assets),
      gatewayPath,
      assetsPath,
    }),
  });
  return { value, gateway, assets };
}

/** Canonical file text written by `bigbud mobile inputs set`; it decodes back to itself. */
export function encodeMobileNativeInputs(value: RemoteMobileNativeInputsValue): string {
  const { artifacts } = value;
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      trustedKeys: value.trustedKeys,
      stageId: artifacts.stageId,
      gateway: artifacts.gateway,
      assets: artifacts.assets,
      gatewayPath: artifacts.gatewayPath,
      assetsPath: artifacts.assetsPath,
    },
    null,
    2,
  )}\n`;
}

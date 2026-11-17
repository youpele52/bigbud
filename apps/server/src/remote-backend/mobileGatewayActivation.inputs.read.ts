import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  assertLocalSupervisorServiceDirectory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";
import {
  decodeMobileNativeInputs,
  MOBILE_NATIVE_INPUTS_FILE,
  MOBILE_NATIVE_INPUTS_MAX_BYTES,
  MobileNativeInputsRefusal,
  type MobileNativeInputsReason,
} from "./mobileGatewayActivation.inputs.decode.ts";
import type { RemoteMobileNativeInputsValue } from "./mobileGatewayActivation.inputs.ts";

/** Why mobile is off (or that it may attach). Never carries key or file contents. */
export type MobileNativeInputsReport =
  | { readonly kind: "unsupported" }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: MobileNativeInputsReason }
  | { readonly kind: "loaded"; readonly value: RemoteMobileNativeInputsValue };

export function mobileNativeInputsDirectory(homeDir: string, authorityId: string): string {
  if (!/^[a-f0-9]{32}$/.test(authorityId)) throw new MobileNativeInputsRefusal("malformed");
  return join(homeDir, ".bigbud/backend-services", authorityId);
}

const missing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === "ENOENT";
async function guarded<A>(reason: MobileNativeInputsReason, run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof MobileNativeInputsRefusal) throw cause;
    throw new MobileNativeInputsRefusal(reason);
  }
}

/**
 * Artifact bytes are hash-verified when published; here the exact files must already be owned,
 * single-link, non-symlink regular files no other user can write, with the signed size.
 */
export async function assertMobileNativeArtifactFile(path: string, sizeBytes: number) {
  await guarded("unsafe-artifact-file", async () => {
    const stat = await fs.lstat(path, { bigint: true });
    if (
      !process.getuid ||
      !stat.isFile() ||
      stat.uid !== BigInt(process.getuid()) ||
      stat.nlink !== 1n ||
      (stat.mode & 0o022n) !== 0n ||
      stat.size !== BigInt(sizeBytes) ||
      (await fs.realpath(path)) !== path
    )
      throw Error("Unsafe artifact file.");
  });
}

/** Absent directory or file is off (`absent`); every other deviation is refused with a reason. */
export async function readMobileNativeInputs(input: {
  readonly homeDir: string;
  readonly authorityId: string;
}): Promise<MobileNativeInputsReport> {
  try {
    const root = mobileNativeInputsDirectory(input.homeDir, input.authorityId);
    const path = join(root, MOBILE_NATIVE_INPUTS_FILE);
    try {
      await fs.lstat(root);
      await assertLocalSupervisorServiceDirectory(root).catch(() => {
        throw new MobileNativeInputsRefusal("unsafe-directory");
      });
      await fs.lstat(path);
    } catch (cause) {
      if (missing(cause)) return { kind: "absent" };
      throw cause;
    }
    const text = await guarded("unsafe-file", () =>
      readLocalSupervisorServiceFile(path, MOBILE_NATIVE_INPUTS_MAX_BYTES),
    );
    const decoded = decodeMobileNativeInputs(text);
    await assertMobileNativeArtifactFile(
      decoded.value.artifacts.gatewayPath,
      decoded.gateway.sizeBytes,
    );
    await assertMobileNativeArtifactFile(
      decoded.value.artifacts.assetsPath,
      decoded.assets.sizeBytes,
    );
    return { kind: "loaded", value: decoded.value };
  } catch (cause) {
    return {
      kind: "invalid",
      reason: cause instanceof MobileNativeInputsRefusal ? cause.reason : "unsafe-file",
    };
  }
}

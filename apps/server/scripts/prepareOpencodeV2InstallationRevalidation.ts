import { createHash, createPublicKey } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { withV2RecoveryBackup } from "./prepareOpencodeV2RebootRecovery.backup.ts";
import { V2ThreadRecords } from "../src/provider/Layers/OpencodeV2/Orchestration.records.ts";
import {
  readV2ThreadPrivateFile,
  v2ThreadPrivateDirectory,
} from "../src/provider/Layers/OpencodeV2/Orchestration.storage.ts";
import { prepareV2InstallationRevalidation } from "../src/provider/Layers/OpencodeV2/PluginSetup.revalidation.ts";
import { v2OwnerRegistration } from "../src/provider/Layers/OpencodeV2/Orchestration.registration.ts";

/** Explicit maintenance approval only: does not replace the installation or touch native history. */
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "state-dir": { type: "string" },
      "config-root": { type: "string" },
      "backup-dir": { type: "string" },
      "registration-family": { type: "string", default: "legacy" },
      "approve-device-revalidation": { type: "boolean" },
    },
  });
  if (!["legacy", "scoped"].includes(values["registration-family"]))
    throw new Error("V2 --registration-family must be legacy or scoped.");
  if (
    !values["state-dir"] ||
    !values["config-root"] ||
    !values["backup-dir"] ||
    !values["approve-device-revalidation"]
  )
    throw new Error(
      "V2 use --state-dir <existing state> --config-root <canonical native root> --backup-dir <verified private backup> --approve-device-revalidation; this approves exact current-boot identity adoption during subsequent consent-gated Settings setup.",
    );
  if (process.versions.bun)
    throw new Error(
      "V2 installation revalidation requires Node's node:sqlite; build with bun --target=node and run the bundle with Node as documented.",
    );
  const state = path.resolve(values["state-dir"]),
    directory = path.resolve(values["backup-dir"]);
  await v2ThreadPrivateDirectory(state);
  await v2ThreadPrivateDirectory(directory);
  const relative = path.relative(path.join(state, "recovery-backups"), directory);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    (await realpath(directory)) !== directory
  )
    throw new Error(
      "V2 backup must be a canonical private child of this state's recovery-backups directory.",
    );
  const root = path.join(state, "opencode-v2-thread-tools");
  await v2ThreadPrivateDirectory(root);
  const privateKey = await readV2ThreadPrivateFile(path.join(root, "issuer", "private.pem"));
  const key = createPublicKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("V2 existing signer must be Ed25519.");
  const issuer = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  const records = await V2ThreadRecords.open(
    root,
    "installations",
    privateKey,
    key.export({ type: "spki", format: "pem" }) as string,
  );
  const checksums = JSON.parse(
    await readV2ThreadPrivateFile(path.join(directory, "checksums.json")),
  ) as Record<string, string>;
  await withV2RecoveryBackup(
    path.join(directory, "state.sqlite"),
    checksums["state.sqlite"],
    async (databaseDigest, assertCurrent) =>
      prepareV2InstallationRevalidation(
        records,
        values["config-root"]!,
        issuer,
        { directory, databaseDigest },
        assertCurrent,
        v2OwnerRegistration({
          issuer,
          bootstrapAbi:
            values["registration-family"] === "scoped"
              ? "bigbud.thread.bootstrap.v2"
              : "bigbud.thread.bootstrap.v1",
        }).filename,
      ),
    path.join(state, "state.sqlite"),
  );
  console.log(
    JSON.stringify(
      {
        status: "installation-revalidation-approved-awaiting-consent-gated-setup",
        nativeMutation: false,
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error && error.message.startsWith("V2 ")
      ? error.message
      : "V2 installation revalidation preparation failed; private evidence was not printed.",
  );
  process.exitCode = 1;
});

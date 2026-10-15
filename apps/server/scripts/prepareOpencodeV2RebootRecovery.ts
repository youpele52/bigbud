import { Database } from "bun:sqlite";
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
import { prepareV2RebootRecovery } from "../src/provider/Layers/OpencodeV2/RebootRecovery.ts";
import {
  readV2RebootCheckpoint,
  readV2RebootProof,
} from "../src/provider/Layers/OpencodeV2/RebootRecovery.proof.ts";
import {
  assertV2RebootBoundary,
  readV2RecoveryHost,
} from "../src/provider/Layers/OpencodeV2/RebootRecovery.host.ts";
import {
  recoveryAdmissionQuery,
  recoveryBindingQuery,
  recoveryInventoryDigest,
} from "../src/provider/Layers/OpencodeV2/RebootRecovery.evidence.ts";

/** Preparation/check only. Application is exclusively through normal consent-gated Settings setup. */
async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "state-dir": { type: "string" },
      "backup-dir": { type: "string" },
      owners: { type: "string" },
      receipts: { type: "string" },
    },
  });
  if (
    positionals.length !== 1 ||
    !["prepare", "check"].includes(positionals[0]!) ||
    !values["state-dir"]
  )
    throw new Error(
      "Use prepare|check --state-dir <private existing state>; prepare also requires --backup-dir, --owners <comma-separated thread IDs>, and --receipts <comma-separated record names>.",
    );
  const state = path.resolve(values["state-dir"]);
  await v2ThreadPrivateDirectory(state);
  const root = path.join(state, "opencode-v2-thread-tools");
  // Read an existing signer only. This command never generates or exports private keys.
  const privateKey = await readV2ThreadPrivateFile(path.join(root, "issuer", "private.pem"));
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("Existing recovery signer is not Ed25519.");
  const issuer = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const enrollments = await V2ThreadRecords.open(
    root,
    "enrollments",
    privateKey,
    publicKey.export({ type: "spki", format: "pem" }) as string,
  );
  if (positionals[0] === "check") {
    const prepared = await readV2RebootCheckpoint(enrollments);
    if (!prepared || prepared.checkpoint.issuer !== issuer)
      throw new Error("No matching signed recovery checkpoint.");
    const current = await readV2RecoveryHost();
    assertV2RebootBoundary(prepared.checkpoint.host, current);
    const proof = await readV2RebootProof(enrollments);
    if (
      !proof &&
      (recoveryInventoryDigest(await enrollments.inventory()) !==
        recoveryInventoryDigest(prepared.checkpoint.owners) ||
        recoveryInventoryDigest(await (await enrollments.sibling("receipts")).inventory()) !==
          recoveryInventoryDigest(prepared.checkpoint.receipts))
    )
      throw new Error("Recovery inventory changed; do not apply the old checkpoint.");
    console.log(
      JSON.stringify(
        {
          status: proof ? "physically-retired" : "reboot-verified-awaiting-consent-gated-setup",
          checkpointDigest: prepared.digest,
          nativeMutation: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!values["backup-dir"] || !values.owners || values.receipts === undefined)
    throw new Error(
      "Preparation requires a prior private database backup and explicit owner IDs and receipt names.",
    );
  const directory = path.resolve(values["backup-dir"]);
  await v2ThreadPrivateDirectory(directory);
  const relative = path.relative(path.join(state, "recovery-backups"), directory);
  if (
    (process.platform !== "win32" && (await realpath(directory)) !== directory) ||
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(
      "Recovery backup must be a canonical private child of this state's recovery-backups directory.",
    );
  const checksums = JSON.parse(
    await readV2ThreadPrivateFile(path.join(directory, "checksums.json")),
  ) as Record<string, string>;
  const filename = path.join(directory, "state.sqlite");
  for (const kind of ["enrollments", "receipts"] as const) {
    const records = kind === "enrollments" ? enrollments : await enrollments.sibling(kind);
    const inventory = await records.inventory();
    const backedUpNames = Object.keys(checksums)
      .filter((name) => name.startsWith(`${kind}/`))
      .map((name) => name.slice(kind.length + 1))
      .toSorted();
    if (
      JSON.stringify(inventory.map((entry) => entry.name).toSorted()) !==
      JSON.stringify(backedUpNames)
    )
      throw new Error("Current signed inventory differs from the backup; nothing is forgotten.");
    for (const entry of inventory) {
      const text = await readV2ThreadPrivateFile(path.join(records.directory, entry.name));
      const digest = createHash("sha256").update(text).digest("hex");
      if (
        checksums[`${kind}/${entry.name}`] !== digest ||
        createHash("sha256")
          .update(await readV2ThreadPrivateFile(path.join(directory, kind, entry.name)))
          .digest("hex") !== digest
      )
        throw new Error("Current signed ownership does not match the preserved backup.");
    }
  }
  await withV2RecoveryBackup(
    filename,
    checksums["state.sqlite"],
    async (databaseDigest, assertCurrent) => {
      const db = new Database(filename, { readonly: true });
      try {
        db.exec("BEGIN");
        const result = await prepareV2RebootRecovery({
          enrollments,
          issuer,
          threadIds: values.owners!.split(","),
          receiptNames: values.receipts ? values.receipts.split(",") : [],
          backup: { directory, databaseDigest },
          assertCurrent,
          readJournal: async (threadId) => ({
            admissions: db.query(recoveryAdmissionQuery).all(threadId) as Record<string, unknown>[],
            bindings: db.query(recoveryBindingQuery).all(threadId) as Record<string, unknown>[],
          }),
        });
        console.log(
          JSON.stringify(
            {
              status: "prepared-not-retired",
              ...result,
              nativeMutation: false,
              rebootIssued: false,
            },
            null,
            2,
          ),
        );
      } finally {
        db.exec("ROLLBACK");
        db.close();
      }
    },
  );
}

void main().catch((error: unknown) => {
  // Never serialize provider records, database rows, child-process errors, or key material.
  console.error(
    error instanceof Error &&
      /^(?:V2 |Recovery |Current signed|Use |Preparation |Existing recovery|No matching)/.test(
        error.message,
      )
      ? error.message
      : "Recovery preparation/check failed; private evidence was not printed.",
  );
  process.exitCode = 1;
});

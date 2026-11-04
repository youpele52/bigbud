# OpenCode V2 installation identity revalidation

Normal consent-gated setup automatically adopts verified POSIX `st_dev` renumbering,
without a new backup or manual approval on every boot. This is not a claim that
device numbers persist across boots or that inode/byte equality identifies a volume.
It requires an existing signed, same-host reboot recovery seal from an earlier boot,
the existing signer, exact canonical root/plugin inodes, safe UID/permissions, exact
managed bytes, and one consistent old-to-current device transition. Real replacements,
mixed devices, foreign signers, and changed bytes remain blocked. Windows is not adopted.

## Automatic recovery boundary

Passive readiness remains read-only: a uniform device transition requests normal setup.
Setup reuses current expanded trust, native qualification, the metadata-only admission
gate, and the exact-root publication lock. It archives the original signed installation
in a signed recovery audit before conditional replacement, rechecking reboot evidence,
native identities and bytes, consent, and the record revision across that boundary.
It does not rewrite/reload the plugin, retire owners, change epochs, or replay history.
A prior automatic or manual adoption of the same installation requires a strictly later
same-host boot; an old seal cannot authorize a second transition in that same boot.
Retries after an interrupted audit are safe, and successful setup is idempotent.

Missing/invalid/foreign reboot evidence, replacement inodes, changed bytes, unsafe
ownership/permissions, mixed devices, revoked consent, and concurrent successors remain
blocked. Existing records attest safe ownership/permissions, not exact historical mode
bits or a persistent volume UUID. The signed same-host reboot seal is mandatory;
inode and byte equality alone never authorize recovery. Windows is not adopted.

## Exceptional manual maintenance approval boundary

The following runbook remains available for explicitly approved maintenance; it is not
required for the automatically verified same-artifact case. It cannot bypass invalid
evidence or authorize arbitrary replacements.

Do not run this against live user state without separate approval and a verified backup.
Do not delete installation records, edit their device fields, reset the profile, or
rerun legacy owner retirement. This operation never changes enrollment, receipt,
approval, checkpoint, native conversation, or service registration records.

1. Coordinate a quiet maintenance window with the user/parent session. Do not stop
   or restart either application or the shared OpenCode service without approval.
2. Create a new private directory below `<state-dir>/recovery-backups/`. Use the SQLite
   backup API (not copying the live database/WAL files) to create standalone
   `state.sqlite`; check `PRAGMA integrity_check` returns `ok`. Retain the existing
   backup and do not overwrite it.
3. Preserve all signed app evidence (including issuer, installations, recovery,
   enrollments, receipts, retirements, instances, and implementations) and the exact
   managed plugin bytes. Keep private keys local, private, and unprinted. In the new
   backup directory, preparation expects:
   - `installations/<existing signed installation filename>`: exact existing signed record;
   - `bigbud-thread-tools-managed.js`: exact existing managed file, private mode;
   - `state.sqlite`: the verified standalone database backup, private mode;
   - `checksums.json`: a private JSON object containing the SHA-256 of `state.sqlite`
     under the `state.sqlite` key (also retain checksums of the remaining evidence).
4. Verify backup signatures/checksums, canonical paths, and no concurrent changes.
   Confirm the user approves **re-signing this exact installation's filesystem identity**.
   Preparation enforces readonly SQLite `integrity_check = ok`, identical application
   schema, and an exact nonempty durable event-ID ledger match against the selected
   state's readonly snapshot. No persistent database UUID exists: this proves journal
   lineage at that snapshot, not a unique physical database identity. Empty ledgers,
   arbitrary/truncated databases, and unrelated state are rejected. Keep the state
   quiet while making/validating the backup; changed schema/ledger requires a fresh backup.
   A no-follow backup descriptor remains held and its metadata/name identity and
   absence of sidecars are rechecked at signed approval publication.

   Then, from the repository root, build a temporary Node bundle and run it:

   ```sh
   bun build apps/server/scripts/prepareOpencodeV2InstallationRevalidation.ts \
     --target=node --outfile='<private temporary directory>/prepare-installation-revalidation.mjs'
   node '<private temporary directory>/prepare-installation-revalidation.mjs' \
     --state-dir '<state-dir>' \
     --config-root '<canonical native config root>' \
     --backup-dir '<state-dir>/recovery-backups/<new backup>' \
     --approve-device-revalidation
   ```

   Node is required for `node:sqlite` (the installed Bun version does not implement
   it). Bundling also resolves workspace TypeScript imports; no dependency is added.
   Existing Bun-based legacy reboot preparation retains its prior callback contract.

   For the diagnosed development instance, the discovered state directory was
   `~/.bigbud/dev` and native root `~/.config/opencode`; re-confirm both for the
   current process before substituting absolute paths. Shell-quoted `~` is not expanded.

5. The command only writes a signed, exact-installation/current-boot maintenance
   approval archiving the original signed record and backup digest. It does not
   change the installation or native plugin. Retry normal consent-gated Settings
   thread-tools setup using the updated backend (coordinate any required reload).
   Existing native qualification, activation lock, short admission gate, current
   consent, and conditional signed replacement remain mandatory. Exact same-artifact
   identity maintenance uses a separate admission-only authority: it does not require
   foreign owner retirement or native foreground/shell idle because it changes no
   native bytes, code epoch, service, enrollment, callback or history scope. Busy local
   admission still defers it. It never treats retained owners as retired and grants no
   permission to replay their history. Changed-artifact replacement still requires
   actual retirement proof/native idle, with an explicit retained-owner barrier rather
   than a misleading “waiting for idle” status. An unchanged
   plugin is not rewritten/reloaded merely to update its signed identity.
6. Check setup readiness without submitting a paid/model prompt. If native
   qualification still blocks, report that separate blocker; do not disable it.
   Only after separate approval should a real conversation be exercised.

An approval cannot authorize a changed installation, a later boot, a successor
record, or revoked Settings consent. Preparation is retryable before application;
after a crash before replacement, the original evidence and approval remain.
After successful replacement normal same-artifact setup is idempotent. Manual approvals
remain boot-scoped; subsequent verified transitions use automatic recovery instead of
requiring recurring manual backup/approval.

## Validation scope

`PluginSetup.revalidation.test.ts` and `PluginSetup.revalidation.retained.test.ts` use disposable private signed records and
synthetic OS boot observations; it is not native qualification evidence. No live
user data repair, service restart, or provider request is part of these tests.

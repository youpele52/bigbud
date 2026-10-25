# OpenCode V2 reboot recovery handoff — 2026-10-14

## State at preparation

The user explicitly selected **Prepare reboot recovery**. The user, not an agent,
will restart the Mac. No restart, interruption, message, tool replay, retirement,
or native plugin replacement was performed during preparation.

Repository: `/Users/youpele/DevWorld/bigbud` (existing dirty branch; do not reset it).
App state: `/Users/youpele/.bigbud/dev`. This is not the packaged app's state.

Private backup (SQLite online backup completed before external database inspection):

```text
/Users/youpele/.bigbud/dev/recovery-backups/opencode-v2-20261014T113101Z/
```

The backup contains `state.sqlite`, the exact signed enrollment/receipt/installation
records, the managed entry, and `checksums.json`. The preparation command rechecked
the database checksum and exact original record bytes before reading the backup.

Private signed checkpoint (directory mode 0700, file mode 0600):

```text
/Users/youpele/.bigbud/dev/opencode-v2-thread-tools/recovery/7d00b0adba7863698a9b49100ba26f86ba134ab342e96919ecb159c0a4f446c0
```

Checkpoint digest: `fffe8ea3315bffd8fa4b42f49e9880ec2fb715eb793cbcfbe80a664d36b301b9`.
It uses the existing Ed25519 issuer; no private key was exported or replaced.
Do not print checkpoint bodies: archived owner records contain private callback data.

Captured macOS boot session: `1692adc8-b930-45ef-a160-eb7eb88d5e3c`.
Captured `kern.boottime`: seconds `1791193104`, microseconds `317063`.
The checkpoint additionally binds a domain-separated hash of `IOPlatformUUID`.
Service restarts, lease expiry, PID changes, uptime, and environment overrides do
not satisfy the reboot boundary.

Exactly two legacy owners were selected:

- `b1bdbfef-b504-4784-84cc-bbe52216b0c5`
- `4a00c6d7-2690-47d4-89da-2cea5909993e`

Their five admissions are terminal and their two session-creation bindings are
verified in the backup. Preparation hashes the scoped journal identities, not
prompt text. Setup must revalidate those identities against its authoritative live
journal before applying recovery.

Exactly one receipt was selected:
`57c5dc3621fd5ef8355c7999c18ad67e64350b9c25e7febb0bd7b193dbfa6a16`.
It matches a `send_thread_message` call that ended with the integration rejection.
The derived command has no receipt, claim, or committed events. Its outcome remains
**unknown**, not completed or proved not executed. Reboot recovery preserves the
original reserved receipt; `find`/`run` still refuse to dispatch it again.

## After the user restarts the Mac

1. Reopen this repository and say **continue**. Do not delete state or re-run prepare.
2. Run this read-only verification from the repository root:

   ```sh
   bun apps/server/scripts/prepareOpencodeV2RebootRecovery.ts check \
     --state-dir /Users/youpele/.bigbud/dev
   ```

   Expected before application: `reboot-verified-awaiting-consent-gated-setup`.
   Same boot, a different Mac, tampering, or changed original inventories must fail.
   This command does not inspect the live database, create retirement records,
   contact/start OpenCode, install anything, or send a prompt.

3. Use bigbud **built from this checkout**, with the same dev state directory.
   Start the normal `bun dev` workflow if it is not running; use its displayed URL.
   An older packaged app does not contain this recovery code. Preserve the existing
   settings and native trust acknowledgement; do not manufacture a consent permit.
4. Once known native sessions and shells are idle, invoke the ordinary OpenCode
   thread-tools setup/refresh in Settings. Finish the diagnostic agent turn first:
   this agent's OpenCode activity can itself prevent the idle check.
5. Setup applies the checkpoint only under current expanded consent, the closed
   local activation gate, unchanged signed inventories, unchanged verified journal
   evidence, and bounded native idle observations. It stages exact-owner retirement
   pointers and then publishes one signed group seal. An interrupted attempt before
   that seal releases no ownership and can be retried after investigating the failure.
6. The existing managed-install transaction then runs unchanged: ownership checks,
   native busy guards, publication, actual Location/bootstrap identity, and mandatory
   five-tool bridge verification. Recovery itself never rewrites the native entry.
7. Confirm the loaded native plugin uses the replacement artifact and setup reports
   ready before claiming the installation repaired. A later **fresh explicit send**
   is required; no failed message or uncertain tool is automatically resubmitted.

The normal retirement proof remains distinct from reboot evidence. An unknown
receipt still reports `receiptsSettled: false`; later physically safe retirement
can cite the verified reboot checkpoint explicitly instead of fabricating completion.
Unrelated/new owners and receipts never inherit this checkpoint's authority.

## Before restarting

Avoid changing or resuming the affected bigbud threads between preparation and
reboot. If their evidence changes, recovery deliberately refuses this checkpoint;
do not restore the backup over live state or overwrite the checkpoint to force it.

Preparation and the real same-boot rejection were verified. The original enrollment,
receipt, installation and managed-entry bytes match the backup. There are zero
retirement records and one recovery record (the checkpoint, not a settlement seal).
The installed legacy plugin has **not** been replaced. Do not interpret a checkpoint
or synthetic test result as live native readiness or completed retail qualification.

## Post-reboot publication correction

The host-owned second maintenance attempt durably retired both original owners,
preserving the reserved receipt unchanged. Publication then failed before changing
the managed entry: the signed installation recorded device `16777231`, whereas
the rebooted Mac reported `16777234`. Root, plugins directory, and managed-entry
inodes were unchanged (`611056244`, `891242218`, `972772284`).

`RebootRecovery.publication.ts` permits narrowly scoped maintenance revalidation
only in the boot that sealed this checkpoint: the committed signed installation
must match its private backup, all original legacy owners must name its artifact,
the issuer/root must match, all three inodes and exact managed bytes must match,
and all three device numbers must exhibit the same transition. This is explicit
maintenance adoption, not a claim that `st_dev` identifies a persistent volume.
Ordinary installs still require exact device/inode identity. Under the normal
closed activation gate, the full original signed installation and revalidated
identities are archived before publication; no original evidence is deleted.

The original checkpoint and retirement seal are not recreated. Installation and
actual native tool readiness still require a subsequent successful managed job.

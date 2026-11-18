# Remote mobile proof inputs and consent

Operator note for native mobile access on a Linux remote account (decisions D-A and D-B in
[the composition plan](plans/2026-11-17-production-native-mobile-composition-plan.md)).

## Inputs file

The backend attaches its native mobile controller only when it finds a valid, owner-private
inputs file at startup:

```text
~/.bigbud/backend-services/<authority>/mobile-inputs-v1
```

It sits next to `config-v1` and `client-token`. The backend reads it once when it starts, so
restart the backend after writing or removing it. If the file is missing or invalid, mobile stays
off and no controller is attached. `bigbud mobile status` reports `loaded`, `absent`, `invalid`
with a reason, or `unsupported` when the host is not Linux or the backend is not in remote mode.

The file is strict JSON with exactly these fields:

```json
{
  "schemaVersion": 1,
  "trustedKeys": { "<keyId>": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n" },
  "stageId": "mobile-release:<64 hex>",
  "gateway": { "kind": "mobile-gateway", "...": "signed descriptor" },
  "assets": { "kind": "mobile-assets", "...": "signed descriptor" },
  "gatewayPath": "/absolute/path/to/gateway-executable",
  "assetsPath": "/absolute/path/to/assets.tar.gz"
}
```

The backend refuses the file when:

- **The service directory is unsafe** (`unsafe-directory`): it must be owned by the account, mode
  `0700`, with no symlinks on its path.
- **The file itself is unsafe** (`unsafe-file`): it must be a regular, single-link file owned by
  the account, mode `0600`, not a symlink, and at most 256 KiB.
- **The JSON is malformed** (`malformed`): unknown or missing fields, a stage id outside 1–128
  printable ASCII characters, or artifact paths that are relative, non-canonical or identical.
- **The keys are not trusted** (`untrusted-keys`): `trustedKeys` must hold 1–32 pinned Ed25519
  public keys, the same rule as `backend setup --trusted-keys`.
- **The descriptors are not signed** (`unsigned-artifacts`): you need one gateway and one assets
  descriptor with identical compatibility, each signed by a key in `trustedKeys`.
- **An artifact file is unsafe** (`unsafe-artifact-file`): each must be a regular, single-link,
  non-symlink file owned by the account, not writable by group or others, and exactly the signed
  size.

The artifact bytes are hashed when the gateway is published, against the same descriptors. The
`bigbud mobile inputs set` helper also hashes them before it writes the file. It writes the file
atomically and never replaces an existing one; to change the inputs, delete the file and run the
helper again. The descriptor and key files it reads must themselves be `0600`. If you omit
`--stage-id`, the helper uses the signed release id.

## Consent

Durable journal consent can be granted only with `bigbud mobile enable --confirm-consent`. The
command reads the current consent revision through `status`, then sends a grant that applies only
if the revision is still the same.

The grant also turns settings mobile access (`mobileRemoteControl.enabled`) on, before it writes
the journal. That setting stays revoke-only:

- Turning it on grants nothing by itself. Durable consent still needs the CLI grant.
- Turning it off revokes durable consent. The backend also applies this at every start: if the
  setting is off when the backend starts, it revokes durable consent. Without the setting on, a
  grant would therefore not survive the next restart.
- The gateway descriptor and owner admission require the setting too, so mobile access works only
  while both are on.
- A stale grant (`stale-revision`) is refused before the setting changes.

- Every real change bumps the revision and cancels every stage: grant after revoke, revoke after
  grant, and the first mobile write on an older journal, which starts at revision 1.
- Granting while consent is already on changes nothing and keeps the revision, so a running gateway
  stays admitted.
- Successor recovery serves an adopted original only when
  `journal.consent.revision === attempt.consentRevision`. After a revoke and a new grant, an
  original from the earlier grant can therefore only be revoked, never served again.
- The grant is refused while the remote agent is not installed (`not-installed`), when the revision
  has changed concurrently (`stale-revision`), and when the backend authority does not match.

## Stages after a consent change

Every consent change cancels every stage, and a cancelled stage is a replay fence. The stage id in
the inputs file is therefore used only by the first grant that publishes it. After a revoke and a
new grant, activation publishes a stage named `<stageId>.r<revision>` for the new consent revision.
You do not need to change the inputs file.

- An original from an earlier grant still names its own stage and revision, so it can only be
  revoked, never served again.
- An activation that fails before native Start reports `failed` with the step that failed, and the
  controller keeps its phase (for example `idle`). Only work that reached native Start can leave
  the controller `uncertain`.

### Retiring old stages

Consent cycles are unlimited. Every publication, and every `bigbud mobile repair`, first retires
stages that are provably unused, so the journal stays small. A stage is retired only when all of
these hold:

- It belongs to an earlier consent revision (so it is already cancelled and cannot be served).
- The desired selection does not name it.
- Every gateway attempt of its revision is settled: its exit was recorded, or its native epoch
  ended (`repair --resolve` or the automatic check at attach). These are the same evidence rules as
  the orphan GC and `--resolve`.
- No gateway base pin of those attempts remains.
- Each original's runtime-asset tree and receipt is already gone. The orphan GC removes them first
  (`mobile repair` runs it before retirement), because its proof needs the attempt record.
- Its published files are the journal's exact owner-keyed directory, anchored by device and inode,
  and hold only the two component files, each matching the publication receipt. A foreign or
  changed member is preserved, and the stage is kept.
- Its attempts and history rows are the oldest in the journal. Older live history has to retire
  first.

Retirement removes the files with the same stamp-checked, non-recursive removal as the orphan GC,
then retires the stage, its settled attempts, its history rows, and releases nothing else uses, in
one journal write. Files go before rows, and missing files count as removed, so a crash at any
point is finished by the next run. A retired stage id is never issued again, and a new stage must
belong to a newer revision than every retired one. A small `retired` tally in the journal keeps
the selection and attempt sequences continuous. Older backends without this support refuse to
read such a journal (they fail closed).

`bigbud mobile repair` prints one line per stage, for example
`retired inputs-stage.r3: retired` or `kept inputs-stage.r5: desired`. Other reasons are
`current-consent`, `unsettled-attempt`, `pinned`, `history-order`, `runtime-assets-present`,
`publication-unverified`, `publication-foreign`, `removal-failed` and `journal-changed`. While an
activation holds the publication, retirement is skipped ("did not run") and happens at the next
publication.

The journal still holds at most 16 stages as a safety bound. Activation refuses only when all 16
are still live. It then fails before native Start with `stage-budget-exhausted`, not
`publication-failed`, and the CLI tells you to run `bigbud mobile repair` (with `--resolve` after
a reboot) to settle and retire old stages.

Activations within one consent revision share that revision's stage and still count against the
journal's 16-entry selection history and 32-entry attempt ledger. Those rows retire with their
stage after a later grant and a newer selection, not before.

## Status reasons

`bigbud mobile status` shows the last outcome with a fixed reason and, in brackets, the innermost
error name, for example `failed: route-unverified [MobileGatewayRouteUnverified]`. Reasons never
carry paths, tokens or server text. A stop caused by revoking consent reads `consent-revoked`, an
owner stop reads `stop-requested`, and a failed HTTPS route check reads `route-unverified`. The
full cause is written to the backend log.

## Repairing an uncertain gateway

A gateway attempt stays `uncertain-repair` while nothing proves its original native gateway ended.
Two kinds of evidence prove it:

- **Prior boot:** the controller that started the gateway ran in an earlier kernel boot.
- **Settled supervisor exit:** the canonical agent journal shows that the native supervisor epoch
  owning the gateway was replaced after its exit receipt. The supervisor writes that receipt (exit
  143 or 0) only after every owned lease, the gateway included, has stopped.

When the backend attaches, it settles such an attempt automatically if the evidence is there. You
can also run the same check yourself:

```sh
bigbud mobile repair --authority <authority> --resolve
```

It clears only attempts with that evidence, then runs the orphan runtime-asset repair. Any other
attempt is kept with a reason:

- `live-epoch`: the current supervisor still owns it.
- `death-unproven`: there is no evidence yet. A reboot provides it.
- `journal-inconsistent`: the attempt record does not match its build pin or epoch.

The command never signals, adopts or guesses about a native process.

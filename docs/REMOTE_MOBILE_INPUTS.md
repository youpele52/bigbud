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
if the revision is still the same. The settings toggle can only revoke consent.

- Every real change bumps the revision and cancels every stage: grant after revoke, revoke after
  grant, and the first mobile write on an older journal, which starts at revision 1.
- Granting while consent is already on changes nothing and keeps the revision, so a running gateway
  stays admitted.
- Successor recovery serves an adopted original only when
  `journal.consent.revision === attempt.consentRevision`. After a revoke and a new grant, an
  original from the earlier grant can therefore only be revoked, never served again.
- The grant is refused while the remote agent is not installed (`not-installed`), when the revision
  has changed concurrently (`stale-revision`), and when the backend authority does not match.

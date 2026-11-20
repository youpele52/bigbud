# Mobile increment 6: proof inputs, consent enable and owner CLI

Date: 17 November 2026. Plan:
[production native mobile composition](../plans/2026-11-17-production-native-mobile-composition-plan.md),
increment 6, decisions D-A and D-B. Uncommitted.

## What landed

- **Proof inputs (D-A).** `RemoteMobileNativeInputsLive` reads
  `~/.bigbud/backend-services/<authority>/mobile-inputs-v1` once at backend start. It does no IO
  off Linux, outside remote mode or without a backend identity. A missing file means off. An
  invalid file also means off, with a reason category that is logged and shown in status. The file
  format and refusal rules are in [REMOTE_MOBILE_INPUTS.md](../REMOTE_MOBILE_INPUTS.md).
- **Owner-socket protocol.** `POST /api/remote-backend/mobile/owner` sits on the authenticated
  client socket next to pairing. It supports `status`, `consent-enable`, `activate` and `stop`. The
  body must name this backend's authority, and refusals use fixed codes rather than server prose.
- **CLI.** New `bigbud mobile` subcommands: `enable` (requires `--confirm-consent`),
  `activate` (`--origin`, `--port`), `stop`, `status` and `inputs set`. All take `--authority`,
  as `pair` does, and the first four accept `--json`.

## Consent revision semantics (D-B)

- The CLI grants consent with a CAS on the revision it just read. It uses
  `setRemoteAgentMobileConsent`, so every real change bumps the revision and cancels all stages.
- Granting while consent is already on is a no-op: the revision stays the same, and a running
  gateway stays admitted.
- Successor recovery requires `journal.consent.revision === attempt.consentRevision`. After a
  revoke and a new grant, an original from the earlier grant can therefore only be revoked, never
  served.
- The settings toggle still only revokes.

## Behaviours worth knowing

- The inputs are read only at startup. After writing the file, restart the backend.
- At load time the backend checks signatures, the pair, the keys and each artifact file's
  ownership, mode and signed size. It does not hash the artifact bytes then: the publication path
  still verifies size and SHA-256 before anything is staged, and `inputs set` hashes them before
  writing.
- A failed `stop` leaves the activation state in `stopping`. This is existing behaviour, not new.
  `activate` then reports `unavailable` until the backend restarts. `status` shows this as
  `(stopping)`.
- `status` reports orchestration state only, never native readiness or exit evidence.

## For increment 7 (live Lima acceptance)

1. Build or download a signed `mobile-gateway` executable and a `mobile-assets` tar.gz for the VM's
   architecture. Each needs a descriptor signed by a release key whose compatibility matches the
   installed agent, the backend version and the mobile RPC revision. Put the public key in a `0600`
   trusted-keys JSON file.
2. On the VM, as the account: `chmod 600` the descriptors and keys, then run
   `bigbud mobile inputs set ...` and restart the backend.
3. Run `bigbud mobile status` and check that it shows `Proof inputs: loaded` and an attached
   controller. Then run `bigbud mobile enable --confirm-consent` and
   `bigbud mobile activate --origin https://<host>.ts.net --port <p>`, and poll `status`.
4. The plan's remaining items are still open: managed prepare, Start, readiness, the authenticated
   route, revoke, confirmed exit, same-CAS cleanup, the successor after a crash, x86_64 and ARM64,
   and the orphan asset repair path.

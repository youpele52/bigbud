# S4 preparation: paired managed SSH launch traces

This offline checker evaluates **one explicitly reviewed A/B profile cell**. It checks a bounded claim: the supplied launch records show the expected legacy control or intentional denial in A, the expected owner launch or zero-launch result in B, and **zero managed SSH launches outside the recorded owner lineage in B**, including before the action and after its result within the supplied capture. It does not run the product, SSH, a recorder, or a release workflow. A successful check is not S4 acceptance.

Start from the [S4 plan](../../../../docs/plans/2026-11-22-rust-ssh-ownership-plan.md#s4--atomic-activation-failure-behavior-and-dependency-handoff), the [X1–X4 ledger](../../../../docs/plans/2026-11-22-rust-ssh-ownership-s0-ledger.md), and the [G1–G3 operation inventory](../../../../docs/plans/2026-11-22-rust-ssh-ownership-s0-operations.md). Have the reviewer freeze the expected cells, cases, outcome codes, and artifact identities before capture. Do not derive the manifest from whichever traces are available.

| Row | Choose separate cases for each applicable path                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | Backend/standalone startup, DB binding, competing entry and old CLI delegation. Include an A positive legacy control and a B attempt through the retired entry with zero SSH. Test late writes separately against the real DB.                                                                                         |
| X2  | Detached terminal host plus Bun PTY/node-pty paths where supported. Attempt the old SSH entry after drain; verify actual retirement, preserved non-SSH behavior and durable pane state separately.                                                                                                                     |
| X3  | Legacy master, monitoring and relay restart paths, including offline-only entries. Capture indirect children through wrappers and reparenting. Verify old transports drained and unrelated user processes are untouched separately.                                                                                    |
| X4  | Existing role denials, e.g. deployed role trying local-only deployment/client relay, or receiver/viewer trying initiation. Use the actual caller role, exact denial and zero SSH in both builds. Check manual SSH as a separate exclusion control; never omit a managed child's record because it descends from a PTY. |
| G1  | Local Git/`gh` indirect transport, explicit operations and background status/refresh. Include command wrappers and applicable approved or refused helper paths.                                                                                                                                                        |
| G2  | Separate authorized thread shell and provider-workspace dispatch from ACP, MCP and other adapter paths; include applicable wrong-thread/role and owner-failure cases.                                                                                                                                                  |
| G3  | Coordinator enrollment/keyscan and pinned relay/follower reconnect where admitted; use the actual unsupported-role denial elsewhere. Key generation alone is not a transport launch.                                                                                                                                   |

Use `legacy-baseline` in A only when the control action is expected to launch managed transport. Use `intentional-denial` for an already unsupported case, with `zero-ssh` in B. An expected rejection in B of a formerly available legacy entry, or a missing/incompatible/crashed owner with no fallback, uses `legacy-baseline` paired with `zero-ssh`; it is not an intentional denial in A. `owner-only` requires a positive B transport launch. Exact, redacted action outcome identifiers are compared to the manifest on both sides. The checker requires every row, at least one legacy-entry negative pair for each of X1–X3, an X4 denial, and a positive B control. A case may be too narrow despite those minimums; the reviewer must map every mandatory per-caller scenario to cases, not treat one example as row completeness.

## Capture and normalize

For a later **authorized, isolated** run, use the migration-aware rollback A and exact candidate B against the intended disposable ownership domain. Keep raw process, artifact verification, role/action and lifecycle observations for review in the controlled evidence store; pass only the redacted normalized records to this utility. No real user hosts, credentials, profiles, SSH configuration, raw argv/env, usernames or path components should appear in these inputs.

1. Record creation and executable image changes, including shell `exec`, short-lived children, descendant wrappers and detached/PTY processes, from before the isolated case through the required delayed-fallback observation window. Use original creator/image lineage, not a `ps` snapshot or current PPID. Carry creation identities across reparenting and use a new `instance` for a reused PID. Configure the recorder and filter to retain **all** image transitions in the managed cohort, not just names matching `ssh`. Include case setup/teardown and any retry window in the post-cutover capture; use a separate live-upgrade/retirement capture rather than mixing pre-cutover A transports into a B launch run. If any required part is unavailable or lossy, leave the cell unproven.
2. Use a single recorded product or harness root per run. Under a harness root, include all managed launch roots and the real request actor under their observed creators (including standalone/offline attempts); never create parent edges to reconnect orphaned records. Capture before detachment if that is what preserving lineage requires. Run unrelated/manual SSH sentinel tests separately, not by carving out arbitrary subtrees from a managed trace.
3. Sequence the request-begin and observed result markers with image events in the same capture. For asynchronous activity, keep recording after the result. The checker requires transport in the action interval for a positive control and counts outside-owner launches anywhere in the B capture. A denial needs a real observed actor and result, not a missing trace or a statement that a code branch should deny.
4. Bind the run to the externally verified release artifact and profile cell. The `owner` ID must be the verified native image instance, cross-checked against runtime verification/attachment evidence and the manifest image hash. Never select it by basename or assume that every copy of the right bytes was the authorized owner. Use separate runs for different owner lifetimes. Transport recognition combines exact basenames (`ssh`, `ssh.exe`, `ssh-keyscan`, `ssh-keyscan.exe`, case folded) with the reviewed image digest inventory for renamed executables. Record the actual resolved basename and digest, not the requested command string. A renamed unknown implementation not in that image inventory is not magically recognized.

## Input format

The first file is an object with exactly these fields. This is a **fragment** with sample identifiers and fake hashes; fill the `cases` array with the complete reviewed matrix for this cell. `cell` identifies the exact OS build, product runtime/mode, and any other variant in your reviewed manifest. `dbDomain` identifies the canonical disposable storage binding and `schema` its exact migration ceiling. Values are redacted tokens, at most 128 characters, matching `[A-Za-z0-9][A-Za-z0-9_.-]*`. SHA-256 digests are 64 lowercase hex characters.

```json
{
  "kind": "cutover-plan-v1",
  "binding": {
    "profile": "N",
    "os": "linux",
    "arch": "x64",
    "cell": "node22-linux-build1",
    "dbDomain": "db-1",
    "schema": "35"
  },
  "a": {
    "id": "rollback-A",
    "sha256": "1111111111111111111111111111111111111111111111111111111111111111"
  },
  "b": {
    "id": "candidate-B",
    "sha256": "2222222222222222222222222222222222222222222222222222222222222222"
  },
  "ownerSha256": "3333333333333333333333333333333333333333333333333333333333333333",
  "sshSha256": ["4444444444444444444444444444444444444444444444444444444444444444"],
  "cases": [
    {
      "id": "x2-retired-entry",
      "row": "X2",
      "aMode": "legacy-baseline",
      "bMode": "zero-ssh",
      "aOutcome": "opened",
      "bOutcome": "legacyEntryFenced"
    }
  ]
}
```

The second file is `{"kind":"cutover-process-traces-v1","runs":[...]}`. Include exactly one A and one B run per case, with globally unique run IDs. Sample B record for the case above:

```json
{
  "id": "x2-B-1",
  "caseId": "x2-retired-entry",
  "side": "B",
  "binding": {
    "profile": "N",
    "os": "linux",
    "arch": "x64",
    "cell": "node22-linux-build1",
    "dbDomain": "db-1",
    "schema": "35"
  },
  "artifact": {
    "id": "candidate-B",
    "sha256": "2222222222222222222222222222222222222222222222222222222222222222"
  },
  "capture": { "scope": "creation-and-exec-lineage", "complete": true, "lostEvents": 0 },
  "action": { "actor": "old-entry-client", "outcome": "legacyEntryFenced", "begin": 3, "end": 4 },
  "owner": null,
  "images": [
    {
      "seq": 1,
      "id": "harness",
      "instance": "p1",
      "via": "root",
      "from": null,
      "basename": "runner",
      "sha256": "5555555555555555555555555555555555555555555555555555555555555555"
    },
    {
      "seq": 2,
      "id": "old-entry-client",
      "instance": "p2",
      "via": "spawn",
      "from": "harness",
      "basename": "entry-client",
      "sha256": "6666666666666666666666666666666666666666666666666666666666666666"
    }
  ]
}
```

Sequence numbers are positive safe integers. Images are sorted by `seq`; gaps are allowed, not evidence of zero loss. `root` is first with `from: null`; `spawn` refers to the creator's image with a fresh `instance`; `exec` refers to the previous image of the same instance. `id` identifies one image event, not a PID. `owner` is null where no verified owner was observed. See [the synthetic fixtures](check.test.ts) for complete paired inputs and bypass examples.

From the repository root, with local Bun:

```sh
bun run protocol/ssh-owner/release-evidence/cutover/verify.ts /path/to/redacted-plan.json /path/to/redacted-traces.json
bun run vitest run --config protocol/ssh-owner/release-evidence/cutover/vitest.config.ts protocol/ssh-owner/release-evidence/cutover/check.test.ts
```

Exit 1 rejects incomplete, mismatched, invalid, or failing records. Exit 0 means `launch-traces-conform` for these inputs only. The report labels A baselines/intentional denials, gives per-run owner and legacy counts, and always emits `retirement: "unproven"` and `s4Accepted: false`. A preflight checklist or a locator without process records cannot pass. The tool cannot authenticate JSON, verify signatures or image bytes, prove that the recorder really observed an event or had no loss, or detect intentionally omitted events. Cross-check normalization against the underlying captures.

## Check an ordered A → B → A rehearsal

The round-trip verifier joins the [forward v3 handoff](../forward/README.md) and [rollback v2 boundary](../rollback/README.md) for one cell. Two standalone passes are not sufficient: separately valid records can describe different artifacts, profiles, DBs, or B process lifetimes. Supply the independently frozen [matrix plan](../matrix/README.md) as the first file and a second JSON file with exactly these fields:

- `kind`: `"cutover-round-trip-v1"`; `scopeReview`: the matrix plan's review token.
- `capture`: `{ scope: "single-forward-rollback-sequence", complete: true, lostEvents: 0, otherAStarts: 0, otherBStarts: 0 }`. This covers the whole interval from forward `before` through rollback `aOpen`, **including the interval between the two boundaries**. Count unaccounted managed A and B starts over that entire interval. Use one recorder ordering and stable process-lifetime tokens throughout; never offset or renumber independently captured runs to make them fit. Unknown capture is not a pass; the products hold no lock across either free-lock interval, so the complete capture is what covers them.
- `forward`: `{ plan, observations }` containing the full standalone forward v2 inputs, not their report.
- `rollback`: `{ plan, observations, profileInstance }` containing the full standalone rollback v1 inputs plus the redacted profile instance **observed at rollback**. Do not fill this token by copying the forward record.

Both sides must match the same required matrix cell, including the exact A/B artifact identities, and agree on profile instance, underlying DB instance, state-dir lock holder (the admitted B writer still holds `backend.lock` at rollback start), and schema/migration digests. Rollback starts strictly after the forward capture's final marker, which includes the delayed refusal observation window. The admitted B owner and writer must appear in the rollback retirement records with their original image and lifetime identities, and the writer must still hold the DB at rollback start. A reopens under a new process lifetime. B may legitimately commit work between these phases, so the checker does not require the rollback state to equal the forward takeover state; each boundary still checks committed-state preservation during its own transition.

```sh
bun run protocol/ssh-owner/release-evidence/cutover/verify.roundTrip.ts /path/to/reviewed-matrix-plan.json /path/to/redacted-round-trip.json
```

Exit 0 reports `round-trip-observations-conform` for the normalized inputs, with `observationsAuthenticated: false`, `rollbackQualified: false`, and `s4Accepted: false`; exit 1 rejects inconsistent or incomplete inputs. Use the underlying records to verify the capture, otherwise matching tokens and sequence numbers are only internally consistent claims. This check neither replaces the separate launch traces nor proves live retirement, platform qualification, or release acceptance.

## Still required before activation

Real X1–X3 retirement needs an exclusive domain fence, quiesced writers, verified exit or acknowledged retirement of managed launch authority, and attempted relaunch through each supported legacy entry. Capture the authorized live relay/monitor/PTY drain, no pane respawn/no late mutation, owner-failure/local-work results, and actual offline A/B rollback against the same DB. A clean post-cutover launch trace, a retained non-SSH host, an absent socket, or a process snapshot does not prove retirement. Review separately against all required signed artifacts, deployment cells, operation parity and the focused structural launch-path inventory. This checker neither scans the repository nor substitutes for that review. It does not publish releases or enable activation or transfer M0.

# SSH owner Build A release (W4) and E7 release-trusted agent bytes

- **Status:** Ready for implementation (D1–D6 decided 2026-11-26; A2 and A3 passed, see §12). Outward steps A4 commit/cut, B1–B3 and M1 still need explicit user approval each.
- **Created:** 2026-11-26 (local, Europe time zone of the workstation)
- **Last modified:** 2026-11-26 (decisions recorded, A1–A3/A5 run at `a763e31ab3`)
- **Project root:** `/Users/youpele/DevWorld/bigbud`
- **Inspected branch / commit:** `feat/ssh-owner-production-activation` @ `ebdf667f6c19cc507718363edfb2783a3e21c3eb`
- **Worktree at inspection:** 91 modified files (uncommitted T-agent U25 work under `apps/server/src/remote-agent/`, `apps/server/src/ssh/`, `apps/server/package.json`). Left untouched.
- **Related:** [finish-line plan](2026-11-25-rust-ssh-ownership-finish-line-plan.md) §3 W4/W5/W6, §5 E1–E8; [S0 ledger](2026-11-22-rust-ssh-ownership-s0-ledger.md) (U25 entry); [S4 cutover design](../2026-11-23-rust-ssh-ownership-s4-cutover-design.md)

## 1. Goal and definition of done

1. **W4:** publish one GitHub release ("Build A") that runs the legacy TypeScript SSH executor only (owner shipped inactive or not at all, per D3), carries the frozen schema ceiling, drain-on-quit with consent, the terminal-host `inventory`/`retireSshSpawn` verb, the systemd `ExecStop` drain and the CLI lock. Its artifact IDs are recorded in the ledger.
2. **E7:** the same release run produces Linux `bigbud-remote-agent` bytes for x86_64/aarch64 gnu and musl, signed with the production key `release-2026` that is pinned in `packages/shared/src/releaseTrust.ts`, published with `remote-agent-manifest.json` and `remote-agent-manifest.v2.json`. The two U25 Linux live tests then pass against those bytes without the local override.

**Acceptance criteria**

- The GitHub release `v<X>` exists and is not a draft. Its assets include the desktop installers (mac arm64/x64 notarized, Linux AppImage, Windows x64 NSIS), `remote-agent-manifest*.json`, `bigbud-remote-agent-<X>-<target>` for all four Linux targets, and the R graph archives.
- The release run summary shows the step "Unsigned Windows release" warning (if D2 = ship unsigned) and **no** "signed with a CI fixture key" error.
- A local, offline check confirms each agent asset's SHA-256 matches the manifest, and the manifest signature verifies against the pinned `release-2026` key.
- The ledger has a "Build A artifact IDs" entry: tag, commit SHA, run ID and attempt, per-asset SHA-256, Authenticode mode, `signingKeyId`, and the highest migration ID.
- The schema-ceiling review record exists (step A2) and names the ceiling decided in D1.

## 2. Background and evidence (confirmed)

- **main == `v0.4.0`.** `git rev-list --count v0.4.0..main` = 0. main stops at migration **180**. This branch is 446 commits ahead and contains 181–187.
- **Migrations on the branch:** 181 `SshOwnerTransitions`, 182 `RecoveredQueueDrafts`, 183 `SshAliasDescriptorBindings`, 184 `SshOwnerRetirement`, 185 `SshLegacyRetirement`, 186 `OrganizationAgeBackfillRepair` (idempotent repair of migration 148 drift; not SSH related), 187 `SshOwnerGuardedWriteJournal` (described as "Build B-side, above the W4 ceiling"). Both 186 and 187 are already **committed** (`c0e5b57545` and later), so HEAD carries them.
- **Therefore Build A cannot be cut from main.** main lacks every A requirement (181/184/185, drain, host verb, ExecStop, CLI lock).
- **Release mechanics** (`.github/workflows/release.yml`):
  - Triggers: a push of tag `v*.*.*`, or `workflow_dispatch` with `version` and `publish` (default false, which gives a dry run: build and verify only, artifacts kept 3 days).
  - Jobs: `preflight` (`scripts/resolve-release-metadata.ts`) → `ci_gate` (CI must have passed for the release commit, so the commit must be pushed and `ci.yml` green) → desktop builds (`release-desktop-build.yml`) → remote agent (`release-remote-agent-build.yml`, `release_signing: true`) → R graph (`release-remote-backend-graph.yml`) → publish (the only job with `contents: write`). No concurrency key, so a release run is never cancelled.
- **Signing secrets assumed:**
  - macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. These are **required**; the job fails if any is missing.
  - Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`. These are **optional**. `scripts/resolve-windows-signing-mode.ts` sets `signed=false`, writes `::warning title=Unsigned Windows release::` and a step summary, and builds without `--signed` or `--require-code-signature`.
  - Agent and graph: `BIGBUD_REMOTE_AGENT_SIGNING_KEY`, `BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID`. These must be the Ed25519 key for `release-2026`; `release.yml:452` fails if assets are signed with a CI fixture key.
- **E7 bytes path.** `release-remote-agent-build.yml` runs `cargo build --locked --release --package bigbud-remote-agent` for x86_64/aarch64 × gnu/musl, then `cargo test`. It strips the binaries and names them `bigbud-remote-agent-<version>-<target>`, with unsigned license sidecars. `release.yml` ~L389–426 runs `scripts/build-remote-agent-release-manifest.ts`, which writes signed v1 and v2 manifests, and verifies them.
- **How the server trusts the bytes.**
  - `remoteAgentInstallSource.trust.ts` reduces the downloaded trust store to `PINNED_RELEASE_TRUST_STORE` (`release-2026`, Ed25519 SPKI). Every manifest `signature.keyId` must survive, or the load fails with "update bigbud".
  - The explicit local override (`BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH`/`_URL`) is what U25 used ("local build, not release-trusted").
  - The remote template then checks size and SHA-256.
- **Owner in release today.** `release.yml` L260–265 and `release-desktop-build.yml` L236–247 already build and verify an **inactive** `bigbud-ssh-owner` and stage it as `server-ssh-owner-*`. Activation is inert unless `SSH_OWNER_PRODUCTION_ACTIVATION` or `BIGBUD_SSH_OWNER_ACTIVATION` is set (`apps/server/src/ssh/sshOwnerProductionComposition.ts`).
- **Versioning.**
  - Tags are `v0.4.0`, `v0.4.0-beta.N`.
  - `docs/CHANGELOG.md` already has a pre-written `## v0.4.1 (29 November, 2026)` entry.
  - The package.json `version` fields (0.1.613) are not the release version; `resolve-release-metadata.ts` derives it from the tag.
  - The `bigbud-changelog` skill edits `docs/CHANGELOG.md` (format `## vX.Y.Z (D Month, YYYY)`, plain-language bullets, a `### Validation` section).
- **W3 state relevant to A (finish-line plan L271–278).** W3.2, W3.3 and W3.5 are implemented. W3.4 ExecStop and drain endpoint are implemented, but the plan text says the "production drain hook [is] typed unavailable", and drain is "not yet composed into installer/updater entry". This must be re-verified (gate A3) before A can claim "drain-on-quit with consent".

## 3. What "no Windows code signing" means

- **Release mechanics: nothing breaks.** The Windows NSIS build runs unsigned. Its verify steps drop `--require-code-signature`, and the run emits an `Unsigned Windows release` warning.
- **For users:** SmartScreen shows "Windows protected your PC" (unknown publisher) on download and first run. Some AV/EDR may quarantine the build. The auto-updater installs unsigned updates, so update integrity relies on the HTTPS/GitHub download plus electron-updater's sha512 in `latest.yml`, not on Authenticode.
- **E3:** this is satisfiable, because E3 asks for "recorded Authenticode mode", not "signed". Record `authenticodeMode: "unsigned"` for both the A and B NSIS artifacts. W6 Windows rows must run unsigned binaries on Win10 22H2 and Win11 runners, so SmartScreen and Mark-of-the-Web must be bypassed in the runner script (`Unblock-File`). Record that as a test-environment note, not a product property.
- **U4 matrix:** the N Windows x64 cell stays in scope. The `server-ssh-owner-win32-x64` binary and the npm native closure are also unsigned. Add a per-cell `codeSignature` field to the matrix row: `mac-*: developer-id+notarized`, `linux-*: none (n/a)`, `win32-x64: unsigned`. Windows arm64 remains unsupported (U4).
- **Unaffected:** E7 and E5. Agent and graph trust use the bigbud Ed25519 release key, not OS code signing.
- **Proposed recording:**
  - In the ledger Build A entry, add `authenticodeMode: unsigned (no certificate; WIN_CSC_* absent; run <id> warning)`.
  - In the finish-line plan §5, add the note "E3 Authenticode mode = unsigned for v1 (user decision D2, date)".
  - In the `release-evidence/matrix/catalog.ts` N win32-x64 cell, add `codeSignature: "unsigned"` as a W5 follow-up code change, outside this plan.
  - Add a changelog line telling Windows users to expect the SmartScreen prompt.

## 4. Assumptions (verify before the outward steps)

| #   | Assumption                                                                              | Evidence                                         | Verify                                                                                |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| S1  | `BIGBUD_REMOTE_AGENT_SIGNING_KEY[_ID]` repo secrets hold the `release-2026` private key | v0.4.0 shipped agent manifests                   | `gh secret list` (read-only) shows both; dry-run step B2 passes the fixture-key guard |
| S2  | macOS signing secrets are still valid (cert not expired, app password live)             | v0.4.0 notarized                                 | Dry run B2                                                                            |
| S3  | An unsigned Windows build passes all non-signature verify steps                         | `resolve-windows-signing-mode.ts` path exists    | Dry run B2                                                                            |
| S4  | Adding a later tag doesn't disturb `marketing`                                          | Memory: marketing sync only on explicit go-ahead | No marketing step in this plan                                                        |

## 5. Scope

- **In scope:** schema-ceiling review; A behaviour gate; choosing the cut point; changelog entry; dry run; tag and publish; E7 verification and ledger recording; W6 handoff of artifact IDs.
- **Out of scope:** B packaging (W5), activation (W7), Windows certificate procurement, the marketing site sync, npm publish changes, committing the U25 worktree.
- **Must not change:** the owner stays inactive in A; legacy SSH behaviour; the pinned trust store; failed-tag reuse convention.

## 6. Implementation steps

LOCAL = safe and read-only, or edits local files only. OUTWARD = needs explicit user approval (commit, push, tag, dispatch, publish).

**A1 (LOCAL) — Record the baseline.**
Run `git rev-parse HEAD`, `git status --short > /tmp/bigbud-buildA-wt.txt` and `git log --oneline v0.4.0..HEAD | wc -l`. Expected output: the SHA, the U25 diff, 446+.

**A2 (LOCAL) — Schema-ceiling review (W4 gate).**
For each of 181–187, read the file and its test. Classify each one as A-required, A-neutral (182, 183, 186) or B-side (187). Write the review as a ledger subsection. The decision is **D1**. The key rule: the rollback path B→A on the same DB requires A to open a DB at B's schema. Check how the migrator treats unknown higher IDs. Search for the "schema-too-new" refusal (`readSshOwnerStartupState` and the migrator in `apps/server/src/persistence/Migrations.ts`).

- If A refuses newer schemas, every B migration must already be in A. Then **187 must ship in A**, and so must every future B table. Otherwise rollback bricks.
- 186 is a pure repair and is safe in A.
- Migration 184 was edited in place while unreleased. After A publishes, 181–187 are frozen: any change needs a new migration.

**A3 (LOCAL) — A behaviour gate.**
Confirm in code and focused tests that:

- (a) drain-on-quit runs from installer, updater and `cli-for-upgrade` with the consent dialog (W3.2/W3.4 "not yet composed" note);
- (b) the host verb is in the shipped `localTerminalHost` binary (protocol 1.10);
- (c) the systemd `ExecStop` renders `--backend-service drain`;
- (d) the CLI lock (W3.5).

Run focused checks only, per AGENTS.md, for example `bun run --cwd apps/server vitest run src/ssh/sshLegacyDrain*.test.ts`. If (a) is still typed unavailable, A is **blocked**. Finish W3.4 composition first, or take D4.

**A4 (LOCAL, then OUTWARD to commit) — Choose and prepare the cut point (D3).**
Recommended: commit or stash the U25 work first, with user approval for the commit. Then create `release/build-a` from a committed SHA that has passed A2/A3, with activation off by default. Do not cut from a dirty tree; CI and `ci_gate` only see pushed commits.

**A5 (LOCAL) — Changelog.**
Use the `bigbud-changelog` skill to finalize the version heading (D5) and date. Add bullets for drain consent, terminal-host retirement and the Windows SmartScreen note. Check formatting with an explicit path: `bunx oxfmt --check docs/CHANGELOG.md`.

**B1 (OUTWARD) — Push the release branch and wait for `ci.yml` green.**
Run `git push -u origin release/build-a`. Verify with `gh run list --branch release/build-a --workflow ci.yml`.

**B2 (OUTWARD) — Dry run.**
Run `gh workflow run release.yml --ref release/build-a -f version=<X> -f publish=false`. Expected result: every job is green, the Windows unsigned warning appears, and there is no fixture-key error. Download the artifacts to an empty `/tmp/bigbud-buildA-dry/<run>` and run the E7 offline check (C1) there.

**B3 (OUTWARD) — Tag and publish.**
Run `git tag v<X> <sha> && git push origin v<X>`. The tag push triggers the run. Do **not** also dispatch, or two publish runs will race.

**B4 — Failed release.**
If nothing was published (no release, or only a draft with no assets), **reuse the same tag**: fix, delete the tag locally and remotely (`git push --delete origin v<X>`), re-tag the fixed commit and push. Each of these steps is OUTWARD. If assets were published, do not delete them. Instead, ship `v<X+0.0.1>`, and if any artifact carrying migrations exists, the migrations stay frozen. Rollback for users: the previous release `v0.4.0` cannot open a DB migrated to 181+. State in the release notes that downgrade below A is unsupported. A itself is the rollback floor.

**C1 (LOCAL) — E7 verification.**
`gh release download v<X> -p 'bigbud-remote-agent-*' -p 'remote-agent-manifest*.json' -D /tmp/bigbud-e7/<X>` (a read-only download). Then check that:

- `sha256sum` matches the manifest entries;
- the manifest signature verifies against the pinned key, using the repo verifier with an explicit path (the same verifier step `release.yml` ~L420 uses);
- `keyId == release-2026`.

**C2 (LOCAL) — Re-run the U25 Linux live tests without the local override.**
Point the install source at the published release (default download path). Run `sshOwnerPickerProof.agentInstall.linux.test.ts`, `…agentReattach.linux.test.ts` and `remoteAgentControl.owner.agentStartup.linux.test.ts` with their documented env flags, 3/3. Replace "local build, not release-trusted (E7 open)" in the ledger with the release tag and digests.

**C3 (LOCAL edit; OUTWARD commit) — Record artifact IDs.**
Add the ledger entry (fields in §1) and mark E7 committed in finish-line §5. W6 takes these IDs as its "A" inputs.

## 7. Validation

- A2/A3 focused Vitest runs and the migration tests `181…187_*.test.ts` through `bun run --cwd apps/server vitest run <files>`.
- Dry run B2 green, plus C1 on the dry-run artifacts before tagging.
- C1 and C2 after publish. Download the release on a clean macOS host and confirm the notarization staple. Confirm that the Windows installer shows the SmartScreen prompt, as expected and documented.
- Full-suite or workspace-wide checks only with separate approval.

## 8. Risks

- **187 placement (D1).** A wrong ceiling bricks B→A rollback. The A2 review is the mitigation.
- **Drain not composed (A3).** Shipping A without it violates U5/U8. That is a hard gate.
- **Unsigned Windows.** SmartScreen friction and possible AV false positives. Document it, and keep D2 revisitable for B.
- **Downgrade below A is impossible** once 181+ migrations apply. Say so in the release notes.
- **Signing key exposure.** The key is only in secrets. The plan never needs it locally.

## 9. Plan validity

Valid for `ebdf667f6c` plus the 91-file U25 worktree. Revalidate if new migrations land (≥188), if `release*.yml` or `releaseTrust.ts` change, if W3.4 composition lands, or if a Windows certificate becomes available.

## 10. Open decisions (user)

| #   | Decision               | Options                                                                                                                                                             | Recommendation                                                                                                                                             |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Build A schema ceiling | (a) 187, ship the guarded-write journal inertly in A; (b) 185/186, revert or move 187 off the A cut; (c) keep 187 out and make A tolerate unknown higher migrations | **(a)**. 187 is already committed and the finish-line risk table says "no B-only migration"; this updates the plan text that calls 187 "above the ceiling" |
| D2  | Windows ships unsigned | (a) unsigned, recorded `authenticodeMode: unsigned`; (b) drop Windows from A/B (breaks U4 N cell and E3)                                                            | **(a)**                                                                                                                                                    |
| D3  | Cut point              | (a) `release/build-a` from a committed SHA on this branch; (b) this branch directly; (c) main (not viable)                                                          | **(a)**, after U25 is committed or excluded; owner shipped inactive                                                                                        |
| D4  | If A3 fails            | (a) finish W3.4 composition first; (b) ship A without drain and require host exit for B                                                                             | **(a)**                                                                                                                                                    |
| D5  | Version                | (a) `v0.4.1` (matches the existing changelog heading); (b) `v0.5.0-beta.1`                                                                                          | **(a)**, with the changelog date adjusted to the real publish date                                                                                         |
| D6  | U25 worktree           | (a) commit it before the cut (A includes the owner-side U25 code, inactive); (b) cut A below it                                                                     | **(a)** if its focused checks pass, since it is owner-only and inert                                                                                       |

## 11. Handoff notes

Order: A1 → A2 → A3 → (decisions) → A4 → A5 → B1 → B2 → C1 on the dry-run artifacts → B3 → C1 → C2 → C3.

Settled: legacy executor only in A; owner inactive; failed tag reused; no marketing sync; no push without approval. Blockers to "Ready": D1–D6 and gate A3.

## 12. Decisions and local results (26 November 2026)

### User decisions

| #   | Decision                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Include 181–187 in Build A; ceiling 187 (A2 confirms this is required, not optional)                                                                                                                                                                         |
| D2  | Windows ships unsigned, `authenticodeMode: unsigned`; changelog SmartScreen note added; E3 note added to finish-line plan §5                                                                                                                                 |
| D3  | Cut `release/build-a` from a committed SHA of this branch, owner inactive (activation env vars unset by default)                                                                                                                                             |
| D4  | If any drain/updater/systemd/CLI-lock piece is not composed, finish it first (A3 found none missing)                                                                                                                                                         |
| D5  | **Revised:** version `v0.4.1-beta.1` (supersedes `v0.4.1`). Changelog follows beta precedent: betas get no heading of their own; notes go under the target stable heading `## v0.4.1 (...)`, whose date is set to the stable publish day when `v0.4.1` ships |
| D6  | Done: U25 committed as `a763e31ab3`                                                                                                                                                                                                                          |
| M   | Marketing sync approved for `v0.4.1-beta.1` only, after it publishes successfully (step M1)                                                                                                                                                                  |

### Beta release mechanics (checked locally)

`bun scripts/resolve-release-metadata.ts v0.4.1-beta.1` gives `channel: beta`, `is_prerelease: true`, `make_latest: false`, `update_channel: beta`, `version: 0.4.1-beta.1`. So the GitHub release is a prerelease, is not marked latest, and publishes `beta*.yml` updater manifests: only beta-channel desktop installs are offered it; stable users stay on `v0.4.0`. No workflow runs `npm publish` or sets a dist-tag, so there is no npm effect. The release body uses `generate_release_notes: true`, not the changelog. Nothing in the release workflows touches `marketing`.

### A1 baseline

HEAD `a763e31ab3f951236ffdf42bb77e95685d95ce24`, tree clean except this untracked plan (`/tmp/bigbud-buildA-wt.txt`), 446 commits ahead of `v0.4.0`. The §2 note about an uncommitted 91-file worktree is superseded.

### A2 schema ceiling: pass

Recorded in the [S0 ledger](2026-11-22-rust-ssh-ownership-s0-ledger.md#w4-build-a-schema-ceiling-review-26-november-2026). The downgrade guard refuses any newer schema, so 187 must ship in A.

### A3 behaviour gate: pass (the finish-line W3 status paragraph saying "typed unavailable" / "not yet composed" is stale)

- (a) Drain with consent is composed. `server.ts` provides `SshLegacyDrainHandlerLive` (`startup/backendDrain.live.ts`) under the runtime; it registers the real handler, which runs `runLegacyDrain` with stops, UI or flag consent, pane close, owned-master exit, commit and lock release. The desktop updater calls `createUpgradeDrain` from `main.bootstrap.ts` as `drainBeforeInstall`. The CLI `backend stop --for-upgrade` reaches the same socket (`cli.backend.operations.ts`, `cli.backend.drain.ts`).
- (b) Host verbs: protocol 1.10 inventory/`retireSshSpawn` in `terminal-host/localTerminalHost.retirement*.ts` and the Rust host.
- (c) `crates/bigbud-remote-agent/src/backend_service/unit.rs` renders `ExecStop={launcher} --backend-service drain {path}` before `ExecStopPost`.
- (d) CLI lock: `cli/cli.backendLock.ts`, `startup/cli.stateLock.test.ts`.
- Known, accepted limits (not composition gaps): Windows has no drain control yet, so the updater skips the drain there (W6, changelog says so); the server labels every drain `cli-for-upgrade` (the label is only used for the supported-trigger check, never persisted); live packaged/systemd runs remain W6 evidence.

### Local checks

| Command                                                                                                                                                                                                                                                              | Result                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bun run --cwd apps/server vitest run` on 181/184/185/186/187 migration tests, `Migrations.downgradeGuard`, `backendDrain.{live,processExit,stops}`, `cli.backend.drainOnStop{,.production}`, `localTerminalHost.retireSshSpawn`, `remoteAgentProtocol.terminalHost` | 13 files, 43 tests passed                                                                  |
| `bun run --cwd apps/server vitest run src/startup/cli.stateLock.test.ts`                                                                                                                                                                                             | 5 passed                                                                                   |
| `bun run --cwd apps/desktop vitest run src/updater/upgradeDrain.test.ts src/updater/autoUpdater.install.test.ts`                                                                                                                                                     | 22 passed                                                                                  |
| `cargo test --locked -p bigbud-remote-agent backend_service` / `terminal_host`                                                                                                                                                                                       | 71 / 4 passed                                                                              |
| `bun run --cwd scripts vitest run` on the manifest, remote-agent asset, mac manifest merge and package-version tests                                                                                                                                                 | 31 passed                                                                                  |
| `bun scripts/resolve-release-metadata.ts v0.4.1-beta.1`                                                                                                                                                                                                              | as above                                                                                   |
| `node scripts/check-release-source-tree.ts 0.4.1-beta.1`                                                                                                                                                                                                             | lists the uncommitted changelog/plan files; rerun after the A4 commit and expect no output |
| `bunx oxfmt --check docs/CHANGELOG.md`                                                                                                                                                                                                                               | pass                                                                                       |

Not run locally: `verify-release-signing-key-pin.ts` (needs the private key file), desktop packaging and the asset verifiers (need a full signed build; B2 covers them).

### Outward commands (each needs explicit approval; run in order)

A4, commit and cut (local commit, then local branch):

```sh
cd /Users/youpele/DevWorld/bigbud
git add docs/CHANGELOG.md docs/plans/2026-11-27-ssh-owner-build-a-and-e7-release-plan.md \
  docs/plans/2026-11-25-rust-ssh-ownership-finish-line-plan.md docs/plans/2026-11-22-rust-ssh-ownership-s0-ledger.md
git commit -m "Prepared the v0.4.1-beta.1 Build A release notes and plan"
node scripts/check-release-source-tree.ts 0.4.1-beta.1   # expect clean
git branch release/build-a HEAD
```

B1, push and wait for CI:

```sh
git push -u origin release/build-a
gh run list --branch release/build-a --workflow ci.yml --limit 1
gh run watch <ci-run-id> --exit-status
```

B2, dry run (no publish):

```sh
gh workflow run release.yml --ref release/build-a -f version=0.4.1-beta.1 -f publish=false
gh run list --workflow release.yml --branch release/build-a --limit 1
gh run watch <run-id> --exit-status
mkdir -p /tmp/bigbud-buildA-dry/<run-id> && gh run download <run-id> -D /tmp/bigbud-buildA-dry/<run-id>
```

Then C1 on the dry-run artifacts. B3, tag and publish (the tag push triggers the release; do not also dispatch):

```sh
git tag v0.4.1-beta.1 "$(git rev-parse release/build-a)"
git push origin v0.4.1-beta.1
gh run list --workflow release.yml --limit 1
gh release view v0.4.1-beta.1 --json isPrerelease,isDraft,assets
```

Then C1 against `gh release download v0.4.1-beta.1 ...`.

### M1 (OUTWARD, approved for `v0.4.1-beta.1` only): marketing sync

Precedent: the `marketing` commits "Brought marketing up to the v0.4.0 release" (`50c170a415`) and the v0.4.0-beta.6 sync make marketing's tree exactly the release commit's tree, as one squash commit on `marketing`. Run only after B3 publishes and C1 passes:

```sh
cd /Users/youpele/DevWorld/bigbud
git fetch origin marketing --tags
git switch marketing && git merge --ff-only origin/marketing
git read-tree -u --reset v0.4.1-beta.1
git commit -m "Brought marketing up to the v0.4.1-beta.1 release" -m "Marketing's tree is exactly the v0.4.1-beta.1 release commit's tree."
git diff --stat v0.4.1-beta.1 HEAD   # expect no output
git push origin marketing
git switch feat/ssh-owner-production-activation
```

Verify: `git diff --quiet v0.4.1-beta.1 origin/marketing && echo identical`, then watch the Pages deployment for `marketing` and check that the site's download links resolve for the beta.

## 13. Build A′ (`v0.4.1-beta.2`): drain consent fix (27 November 2026)

### Reason

W6 found that Build A's (`v0.4.1-beta.1`) upgrade drain UI consent is unreachable. Nothing registers the UI as an in-process consent subscriber; the web consent dialog only polls `getBackendDrainConsent`. Every `consent: "ui"` drain therefore answered `consent-required`, and A's desktop updater refused every install. The user approved shipping a corrected Build A′.

### Fix (backported from `9bbaae5cb4` on `feat/ssh-rust-only`, adapted to A)

- A polling web UI counts as present for drain consent: `getBackendDrainConsent` records the poll (`noteBackendDrainUiPoll`), and a poll within `BACKEND_DRAIN_UI_PRESENCE_MS` (5 s) makes the UI present, so the consent dialog is reachable (`apps/server/src/startup/backendDrain.consent.ts`, `apps/server/src/ws/wsRpcHandlers.backendDrain.ts`; test `backendDrain.consent.uiPresence.test.ts`).
- Drain failures carry their error text: a tagged failure answers its `detail` instead of an empty message (`apps/server/src/startup/backendDrain.live.ts`; test in `backendDrain.live.test.ts`).

Not backported (Build B/owner-only): the marker profile-scope read, B's drain not rewriting A's marker (`commitOwnerBuildDrain`), and the owner's stale `owner.sock` cleanup. A stays legacy-executor-only with the inactive owner, and A's marker behaviour (written under scope `backend` by `commitLegacyRetirement`) is unchanged.

### Version and rollback floor

- Version: `v0.4.1-beta.2`, released from `release/build-a`. The `## v0.4.1 Preview` changelog section stays empty by the user's choice.
- A′ replaces A as the rollback floor: `v0.4.1-beta.1` cannot complete a UI-consent upgrade drain, so every B rollback and every upgrade path must target `v0.4.1-beta.2` or later.
- Outward steps (tag, workflow dispatch, push, marketing sync) follow section 12 with `v0.4.1-beta.2` substituted and each needs fresh explicit approval.

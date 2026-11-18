# Mobile increment 7: live acceptance (aarch64, Lima)

**Date:** 17–18 November 2026, 23:38–00:10 UTC
**Plan:** [Production native mobile composition](../plans/2026-11-17-production-native-mobile-composition-plan.md), increment 7
**Related:** [Increment 6](2026-11-17-mobile-increment-6-inputs-consent-cli.md),
[Orphan asset repair](2026-11-17-mobile-orphan-runtime-asset-repair.md),
[M1 live systemd acceptance](2026-11-17-m1-live-systemd-acceptance.md),
[Proof inputs](../REMOTE_MOBILE_INPUTS.md)
**Verdict:** **Not accepted.** The native core works live: managed prepare, Start, original-child
readiness, confirmed native exit, same-CAS cleanup, consent revoke, successor adoption of a live
original, the Gone variant, revoke during the successor, old-epoch → uncertain, and orphan repair.
Five product defects block acceptance:

- **F1:** `mobile enable` can never grant consent.
- **F3:** a fixed stage id can never be reused after a consent change.
- **F4:** a successor can adopt a live gateway but can never be admitted.
- **F5:** `backend stop` with an active gateway leaves Rust needing repair.
- **F6:** the resulting uncertain state has no owner repair path.

Authenticated route admission could not be exercised at all (F9). It needs real Tailscale Serve
and a publicly trusted HTTPS name.

## Environment and inputs

- **Source:** `git archive` of HEAD `0e861b541a` (tree `dfad7d00…`). The working tree and other
  lanes' uncommitted work were not used. `node_modules` was APFS-cloned in.
- **Backend graph:** `0.1.613-dev.inc7`, `aarch64-unknown-linux-gnu`, buildDigest `9d63ceea…`,
  archive `e974e00b…`, 8,048 files. The producer passed unmodified, so F7 from M1 stays fixed.
- **Rust agent and mobile gateway:** built in one disposable `node:24.13.1-bookworm` container
  (rustup 1.95.0, `--locked --release`, `aarch64-unknown-linux-musl`, stripped, static).
  - Agent `0.3.3-inc7.4d34521266b6`, protocol 1.8, sha256 `433179f0…`.
  - Gateway sha256 `809aa448…`.
- **Mobile assets:** `VITE_MOBILE_BASE=/mobile/ vite build` of `apps/mobile-web`. Signed with
  `bun run package:mobile-components` (gateway target `aarch64-unknown-linux-musl`). The asset
  archive is `7c8e50c6…`.
  - **Deviation:** `_redirects` was removed from the staged copy (F7).
- **Signing:** the graph, both agent manifests and both mobile descriptors were signed with the
  dev **fixture** key `dev-fixture-20261117`. No release key was used. Compatibility: agent
  `0.3.3-inc7.4d34521266b6`, backend `0.1.613`, mobile RPC 1..1.
- **VM:** Lima `bb-mobile-inc7` (vz, Ubuntu 22.04.5 arm64, systemd 249, `mounts: []`, every
  port forward ignored). Two fresh lingering accounts:
  - `bbmob` (authority `c8e999e2…`).
  - `bbmob2` (`5820ab08…`), used only for row 13.
- **Test origin:** `https://bb-mobile-inc7.example.ts.net`, port `47390`.
- **Validator harness (not product code):**
  - `consentDriver`: works around F1. It runs the product's own `RemoteMobileConsentJournalLive`
    under the backend state-dir lock, with the backend unit stopped.
  - `mobdrv`: a paired-client and settings driver.
  - A `tailscale` **stand-in** plus a stalling `127.0.0.1:443` listener. It only holds the route
    check open for about 4 s, so the validator can act while the original child is alive. It
    cannot make the route pass.
  - Watcher scripts that `SIGSTOP` the backend at the route check.

## Results

| #    | Step                                                     | Result                                   | Key evidence                                                                                                                                                                                                                                                                                                |
| ---- | -------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `backend setup` from the graph, then `backend start`     | **PASS**                                 | Setup exit 0. Rust Active; backend Active, crash-restarts 0                                                                                                                                                                                                                                                 |
| 2a   | `mobile inputs set`, restart; controller attached        | **PASS**                                 | File written (stage = release id); after restart `Controller: attached, phase idle`; attach-time repair ran (0/0)                                                                                                                                                                                           |
| 2b   | `mobile status` shows inputs loaded and consent          | **FAIL (F1)**                            | It always shows `Proof inputs: unsupported` and `Consent: unavailable`, even with the controller attached and journal consent enabled                                                                                                                                                                       |
| 3a   | `mobile enable --confirm-consent`                        | **FAIL (F1)**                            | `{"ok":false,"refused":"unavailable"}`. Consent was then granted through the validator driver (deviation)                                                                                                                                                                                                   |
| 3b   | `mobile activate`; poll status                           | **PASS (with F2, F3)**                   | `accepted`; phase `running` → `idle`. Consent survives only if settings mobile access was on at backend start (F2)                                                                                                                                                                                          |
| 4a   | Managed native prepare                                   | **PASS**                                 | Stage `files-published`; desired-selection CAS committed; attempt reserved → `attempted` with `nativeOwnership` and an `assets-<hex>` tree plus receipt on disk                                                                                                                                             |
| 4b   | Native Start                                             | **PASS**                                 | Original child, for example PID 16882: `/proc/self/fd/4 --listen 127.0.0.1:47390 --upstream-unix …/remote-mobile.sock --stdin-lifeline --assets-dir …`. It is a child of the Rust supervisor's spawner, not of the backend                                                                                  |
| 4c   | Original-child readiness                                 | **PASS** (inferred)                      | The original child held the listener (`ss` pid = child). The backend reached its post-readiness route check: stand-in called, and the Rust Start only returns a lease after readiness (`owner.rs:141-160`)                                                                                                  |
| 4d   | Authenticated mobile route admission (paired client)     | **BLOCKED (F9)**                         | Admission needs a verified Tailscale Serve route and a public-trust HTTPS probe; every session ended `failed` at that check. Live negatives: the unadmitted gateway serves assets, `mobileCapable:false`; `/ws` and backend API 404; `/mobile-ws` without or with a forged token 401; `mobile pair` refused |
| 4e   | Consent revoke (settings toggle) → confirmed native exit | **PASS** (before admission)              | Revoke at `23:51:53.817`: journal consent rev 3→4 disabled; the stop came about 0.5 s later, before the second route call; `exit-confirmed`, `native-exit` gen 0, `originalChildPid 20353`                                                                                                                  |
| 4f   | Same-CAS cleanup                                         | **PASS**                                 | Every original-controller exit removed its tree and receipt (`remote-mobile-runtime-v1/` empty after rows 4a–4e)                                                                                                                                                                                            |
| 5a   | Successor: gateway active, `kill -9` backend             | **PARTIAL: adopt PASS, ready FAIL (F4)** | Gateway 38985 survived; systemd restarted the backend (NRestarts 1); successor `running` with the **same listener PID 38985**; recovery reached `ready`, then owner admission failed (outcome `failed`, no route check made); successor stopped it with `native-exit` + `previousController`                |
| 5b   | Gone variant: kill gateway, then backend → exit → repair | **PASS**                                 | Outcome `exit-recorded`, evidence `previousController` 39264 → `currentController` 48681; attach repair `kept 1`; `mobile repair` → `removed assets-1e49…: proven-orphan`; a second run is a no-op                                                                                                          |
| 5c   | Revoke during the successor                              | **PASS**                                 | Revoke accepted `00:00:38.784` (rev 6, disabled) → `exit-recorded` at `00:00:39.306`; orphan removed by `mobile repair` (`proven-orphan`)                                                                                                                                                                   |
| 5d   | Old-epoch lease after a Rust restart → uncertain         | **PASS**                                 | Row `attempted` with nativeEpoch `1794958973…`; Rust epoch after reboot `1794960350…`. Phase `uncertain-repair`, `failed (repair required)`. `activate` refused; `stop` refused (uncertain); repair kept `attempt-not-exited`; this persists across a backend restart                                       |
| 5d\* | Same via `systemctl --user restart` of the Rust unit     | **INVALID**                              | The backend was SIGSTOPped, so its lease peer stayed attached and the drain could not settle (an artefact of the method). Recovered by reboot; 5d was redone via reboot                                                                                                                                     |
| 11   | First successor attempt                                  | **INVALID**                              | The driver did not check that activation was accepted. It had been refused by F3, so no gateway existed. Redone as 5a                                                                                                                                                                                       |
| 13   | Fresh account: `backend stop` while the gateway is alive | **FAIL (F5)**                            | Backend exit 0; Rust `received signal 15` → `could not verify all owned work stopped` → exit 1, no `launch.exit`, Rust NeedsRepair; `backend stop` exit 1; the row stays `attempted` and the tree stays                                                                                                     |
| 6    | `mobile status` / `mobile repair` at each step           | **PASS (outputs captured)**              | `live/*.log`; repair reasons observed: `proven-orphan`, `attempt-not-exited`                                                                                                                                                                                                                                |

Not run: x86_64 (no native host), a physical phone, real Tailscale Serve, the paired client's
authenticated `/mobile-ws` RPC (blocked by F9), and the "ready again on the same PID" half of 5a
(blocked by F4 and F9).

## Findings (read-only diagnosis, no product change)

- **F1 (blocking): the owner route cannot see the consent journal or the inputs report.**
  - `server.remote.routes.ts:28-31` provides `RemoteMobileNativeInputsLive` and
    `RemoteMobileConsentJournalLive` to the route layer with `Layer.provide`.
  - The handler reads them at request time with `Effect.serviceOption`
    (`mobileOwnerActivation.ts:37-38`, `:88`).
  - Effect's `HttpRouter` runs a handler with the request fiber's context
    (`effect@4.0.0-beta.43 src/unstable/http/HttpRouter.ts:165-200`). Layer-level provision never
    reaches it, and `serviceOption` hides the missing requirement from the types.
  - Result: `consent-enable` always refuses `unavailable`, and status always shows
    `inputs: unsupported` and `consent: unavailable`.
  - Unit tests provide the services app-wide (`mobileOwnerActivation.test.helpers.ts:105`), so
    they miss this.
- **F2 (operator trap; documentation and CLI gap): settings mobile access must be on before any
  backend start.**
  - At startup, with settings `mobileRemoteControl.enabled=false` (the default), the settings guard
    revokes durable consent (`ws/serverSettings.ts:107` → `serverSettings.mobileConsent.ts:14-35`).
    Live: rev 1→2.
  - The descriptor and owner admission also require the setting.
  - No CLI turns it on, and `REMOTE_MOBILE_INPUTS.md` does not mention it. The validator used the
    owner client socket's `server.updateSettings`.
- **F3 (blocking after any consent change): a stage id cannot be re-reserved.**
  - Revoke → grant cancels the stage. `reserveRemoteAgentMobileStage` refuses a prior stage that is
    `cancelled` or has another consent revision (`remoteAgentInstall.mobile.transitions.ts:147-157`),
    and stages can never be discarded (`remoteAgentInstall.mobile.invariants.ts:39-49`).
  - The stage id is fixed in `mobile-inputs-v1`, so every later `activate` fails before selection.
  - The CLI reports that pre-selection failure as `uncertain` (`mobileOwnerActivation.ts:112`, via
    `mobileGatewayActivation.controller.ts:149`), although the controller is `idle`.
  - Workaround used: delete the inputs, run `inputs set --stage-id <new>`, then restart. After a
    plain restart, the same `files-published` stage is reminted correctly (`live/14-restart-then-activate-same-stage.log`).
- **F4 (blocking for successor readiness): native admission requires the attempt's controller to
  be this instance.**
  - `mobileGatewayNative.admission.ts:66-82` (line 78: `equal(attempt.controller, authority.controller)`)
    refuses every successor.
  - A successor selects rows precisely because their controller is foreign
    (`mobileGatewayNative.restore.ts:34-49`), and nothing reassigns `attempt.controller`.
  - Live: the successor adopted the original and reached `ready`. `use()` then failed before any
    route check, giving `failed` / `repairRequired:false` (`mobileGatewayNative.successor.ts:62-112`).
  - This is consistent with the code reading. The cause itself is not logged (F8).
- **F5 (blocking): a graceful Rust stop with a native gateway lease never settles.**
  - On SIGTERM, the backend's controller `close()` detaches the gateway
    (`mobileGatewayActivation.controller.ts:238-246`), and the backend exits 0.
  - Rust's drain then calls `stop_service_lease`, whose result is discarded
    (`supervisor/drain.rs:122-131`). The idle fence times out after 2 s (`drain.rs:104-119`), logs
    `could not verify all owned work stopped` (`drain.rs:61`) and exits 1 (`signals.rs:278`) with
    no receipt (`backend_service/launch.rs:145`).
  - Reproduced on a fresh account with a plain `bigbud backend stop`. M1's repair text then
    requires a reboot.
  - The root cause inside `service_lease` retirement is not yet pinpointed.
- **F6 (blocking): `uncertain-repair` has no owner exit.**
  - After F5 and a reboot, the `attempted` row with the old epoch makes every attach end
    `uncertain-repair`. This survives restarts, and `mobile repair` keeps its tree
    (`attempt-not-exited`).
  - The owner protocol has only `status|consent-enable|activate|stop|repair`
    (`mobileOwnerActivation.protocol.ts:21-37`). Nothing can resolve the row, so mobile is
    permanently off for the account without manual journal surgery.
- **F7 (producer mismatch):** `apps/mobile-web/public/_redirects` ships in every build, and the
  asset policy rejects names starting with `_` (`packages/shared/src/mobileOptionalAssets.policy.ts:14-20`).
  A plain mobile-web build therefore cannot be packaged without editing it.
- **F8 (observability):** outcome causes are dropped.
  - `lastOutcome` records only the kind (`controller.ts:154`), and only a thrown `resume` is
    logged (`server.mobileActivation.ts:41-45`).
  - A revoke-triggered stop and a route failure both read `failed` (`launch.ts:101-104`).
  - Diagnosis needed the trace file, which does not cover the successor.
- **F9 (test-plan gap):** route admission requires real Serve. It needs
  `tailscale status/serve --json` to match exactly (`mobileGatewayRouteOwner.ts:69-90`) and a
  default-trust HTTPS probe of `https://<origin>:443/api/mobile/handshake`
  (`mobileGatewayProbe.ts:31-38`). The managed unit's environment is fixed, so no CA override is
  possible. "No Tailscale needed" does not hold for authenticated admission.
- **Minor:** after a failed `mobile stop`, the state stays `stopping`, so `mobile repair` returns
  `unavailable` until restart (`mobileGatewayActivation.state.ts:76`). This is known from
  increment 6.

## Repro steps

1. Run `git archive HEAD` into a fresh `/tmp` directory, then APFS-clone the root and workspace
   `node_modules` (including `apps/web` and `apps/mobile-web`).
2. Build the graph: `(cd apps/server && bunx tsdown && bunx tsdown -c tsdown.clientRelay.config.ts)`,
   then
   `bun run remote-backend-graph --target aarch64-unknown-linux-gnu --dist apps/server/dist --key-file <fixture.pem> --key-id dev-fixture-20261117 --version 0.1.613-dev.inc7 --node-archive <node-v24.13.1-linux-arm64.tar.xz>`.
3. In `node:24.13.1-bookworm`, with `BIGBUD_AGENT_BUILD_VERSION` and `BIGBUD_AGENT_BUILD_DIGEST`
   set, build
   `cargo build --locked --release -p bigbud-remote-agent -p bigbud-mobile-gateway --target aarch64-unknown-linux-musl`
   and strip both. Sign the agent manifest with the M1 `sign-rust-manifest.ts`.
4. Run `VITE_MOBILE_BASE=/mobile/ vite build` in `apps/mobile-web` and drop `_redirects` (F7).
   Then run `bun run package:mobile-components --target aarch64-unknown-linux-musl --agent-version <agent> --backend-version 0.1.613 --minimum-mobile-rpc 1 --maximum-mobile-rpc 1 --key-id dev-fixture-20261117 --key-file <fixture.pem> …`,
   and split `manifest.json` into the gateway and assets descriptors (mode 0600).
5. Create a Lima VM (vz, Ubuntu 22.04, `mounts: []`) and a lingering account. Install the graph and
   metadata, then run `backend setup … --confirm-fresh-setup` and `backend start`.
6. Run `mobile inputs set …` and restart the backend. Status shows F1. `mobile enable --confirm-consent`
   is refused (F1).
7. Grant consent through a driver that runs `RemoteMobileConsentJournalLive.enable` under the
   state-dir lock with the backend stopped. First turn settings `mobileRemoteControl` on, or the
   next start revokes it (F2).
8. Run `mobile activate --origin https://<name> --port 47390`. Without `tailscale` on PATH, the
   session fails after Start and readiness (`exec: tailscale: not found`) and records
   `native-exit`.
9. F3: revoke through settings, re-grant, then activate. It is refused as `uncertain`, and the
   stage stays `cancelled`.
10. F4: during the route check, `SIGSTOP` the backend, then `kill -9` it. The successor adopts the
    same PID and fails admission.
11. F5: on a fresh account, run `bigbud backend stop` within about 4 s of the gateway becoming
    ready. Rust then needs repair.
12. F6: reboot. Every attach then ends `uncertain-repair`.

## What remains

- A physical phone through real Tailscale Serve, which is required for 4d and the "ready again"
  half of 5a.
- x86_64.
- Fixes for F1, F3, F4, F5 and F6, then a re-run of this matrix.
- Documentation of the settings prerequisite (F2), plus a CLI for it or a change to the guard.
- Fixing the `_redirects` and producer mismatch (F7).
- Logging of outcome causes (F8).
- A decision on whether a test seam for route verification is acceptable (F9).
- Updating the mobile ledger and the remote P7 section; not done here.

Evidence: `/tmp/bigbud-mobile-inc7-20261117T233850Z/` (PROVENANCE.txt, logs/, live/, tools/,
vm/, vm-collect/, archive-extra/), archived as
`~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261118-mobile-inc7.tar.zst` with a `.sha256`
file. The archive contains no private key and no client or mobile session token. The VM was
deleted, the build container ran with `--rm`, and nothing else was touched.

## Fixes and re-run (18 November 2026, 05:03–05:41 UTC)

**Verdict:** F1–F8 are fixed and re-run live. F9 is unchanged by design: authenticated admission
still needs real Tailscale Serve and the public HTTPS probe, which stays on the physical
phone/Tailscale checklist. Nothing is committed.

### Root causes and fixes

- **F1 (confirmed):** `HttpRouter` handlers run with the request fiber's services.
  - Two things never reached the handler: `Layer.provide` on the route layer, and the
    `Layer.fresh` the remote listener wraps routes in (which also rebuilt the inputs layer, a
    second read).
  - A negative-control test with the pre-fix wiring reproduces `unavailable`.
  - **Fix:** the consent journal is provided per request through `HttpRouter.provideRequest`
    (`mobileOwnerActivation.routes.ts`). The attach layer records its single inputs read on the
    app-wide activation state, and status reads it from there.
  - Test: `mobileOwnerActivation.routes.test.ts`, using the real route composition with no
    app-wide journal.
- **F2 (confirmed):** the startup guard revokes durable consent whenever the toggle is off.
  - **Fix (D-B kept):** `mobile enable --confirm-consent` turns settings mobile access on first,
    then runs the journal CAS. A stale revision is refused before the setting changes.
  - Turning the toggle on grants nothing, and turning it off still revokes. Documented in
    `REMOTE_MOBILE_INPUTS.md`.
- **F3 (confirmed):** a consent change cancels every stage, and a cancelled stage is a permanent
  fence.
  - **Fix:** the first grant keeps the inputs' stage id. A later revision publishes
    `<stageId>.r<revision>` (`mobileGatewayActivation.stage.ts`). This is deterministic, so a
    remint after restart finds the same stage.
  - Old attempts keep their own stage and revision, so an old original can still only be revoked.
  - A failure before native Start now acknowledges `failed` with the step that failed, and the
    controller keeps its phase. It no longer reports `uncertain`.
  - Bound: the journal keeps at most 16 stages, so consent cycles per installation are finite.
- **F4 (confirmed):** admission compared the immutable original `controller` with the current
  instance.
  - That field cannot be rewritten: the native guard predicates and the assets receipt name it.
  - **Fix:** a new optional `currentController` on the attempt, set by a CAS after a verified
    successor Resume, from exactly the foreign controller that was selected. This mirrors the
    Rust receipt's current/previous controller.
  - Admission and successor selection use `currentController ?? controller`. Journal invariants
    allow only an attempted native row to change it.
  - Tests: `mobileGatewayNative.admission.successor.test.ts` and
    `mobileGatewayLifecycle.native.adopt.test.ts`.
- **F5 (confirmed by a failing Linux test before the fix):** the Rust unit uses
  `KillMode=control-group`, so systemd's SIGTERM also reached the private lease monitor.
  - The monitor had the default disposition (the supervisor's handler resets on exec), so it died
    by signal. `Monitor::stop` then saw a non-success exit, marked the lease uncertain, and the
    drain exited 1 with no receipt.
  - **Fix:** the monitor ignores SIGTERM, SIGINT and SIGHUP (only its owner channel ends it), and
    it restores the defaults for the original child before exec. The drain now logs a failed lease
    retirement instead of discarding it.
  - Test: `tests/service_lease_signal_drain.rs`.
- **F6 (confirmed):** nothing could settle an attempt whose native epoch ended. New evidence kind
  `native-epoch-ended`:
  - **Prior boot:** the original controller's boot id differs from the current boot.
  - **Settled supervisor exit:** a P4 restart of exactly that epoch reached `starting` or `ready`,
    which the core writes only after an exit receipt or a prior-boot proof.
  - It never clears a live epoch or an unproven row.
  - It is applied automatically at attach. The owner can run it on demand with
    `bigbud mobile repair --resolve`, which clears uncertainty only when no unsettled attempt
    remains and then runs the orphan GC.
- **F7:** `apps/mobile-web/public/_redirects` is removed. It was a static-host rewrite with no
  in-repo consumer: the native gateway and the desktop server both do their own SPA fallback. The
  static-only asset policy stays strict, and a plain build now packages unmodified.
- **F8:** `lastOutcome` now carries a fixed `reason` and the innermost error name as `detail`.
  - These never include messages or values. The full cause goes to the backend log.
  - Route-check failures are named `MobileGatewayRouteUnverified`. A revoke-triggered stop reads
    `consent-revoked` and an owner stop reads `stop-requested`.

### Re-run

**Build:**

- Source: `git archive` of HEAD `6716f8b8fe` plus only this fix's files.
- Graph: `0.1.613-dev.fix3`. The producer passed unmodified.
- Agent: `0.3.3-fix.9ffa9610b565`, sha256 `312f9a19…`. The gateway is unchanged (sha256
  `809aa448…`).
- Mobile assets: a plain `VITE_MOBILE_BASE=/mobile/` build, packaged with no edits.
- All signed with the dev fixture key only.

**VM:** Lima `bb-mobile-fix` (vz, Ubuntu 22.04.5 arm64, `mounts: []`). It was deleted afterwards.

**Harness:** the tailscale stand-in and the stalling `:443` listener, as in increment 7. The
consent driver was not needed.

**Validator mistakes (not product defects):**

- The first two graphs were rebuilt to add cause logging and the route-error naming.
- The first mobile descriptors named backend `0.1.614` instead of `0.1.613`, so publication was
  refused as incompatible. They were repackaged.
- The first three accounts were removed to free subordinate-UID ranges.

| Step                                            | Result   | Evidence (`live/`)                                                                                                                                                                         |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 status before enable                         | **PASS** | `04-provision2`: `Proof inputs: loaded`, `Consent: disabled (revision 0)`                                                                                                                  |
| F1 `mobile enable --confirm-consent`            | **PASS** | `02`, `05`, `08`: `granted (revision 1); settings mobile access is on`                                                                                                                     |
| F2 consent survives restart (and a reboot)      | **PASS** | `02`/`05`: still `enabled (revision 1)` after restart; `16`: `revision 3` after reboot                                                                                                     |
| F3 revoke → re-grant → activate                 | **PASS** | `07`: rev 1 → 2 (toggle) → 3 (CLI); stage `….r3` published; native Start (child 28810), then `native-exit`                                                                                 |
| F3 honest pre-Start failure                     | **PASS** | `03`/`05`: `failed before native Start … (publication-failed)`, phase `idle`                                                                                                               |
| F4 successor adoption → admission → route check | **PASS** | `11`: same gateway PID 45656; journal `cur 45831`; the successor's own stand-in call at 05:36:26; outcome `route-unverified` (F9 boundary); `native-exit` with current/previous controller |
| F5 `backend stop` with a live gateway           | **PASS** | `12`: stop returned in 0.6 s; Rust `Result=success`, `launch.exit=143`; gateway gone                                                                                                       |
| F5 backend later reconciles the attempt         | **PASS** | `13`: restart reservation for the old epoch `ready`; attempt `native-epoch-ended / settled-supervisor-exit`; tree removed (`1 removed`)                                                    |
| F6 resolve refuses without evidence             | **PASS** | `14`: Rust SIGKILLed with the gateway live → `uncertain-repair`; `repair --resolve` kept the row (`live-epoch`); controller stays uncertain                                                |
| F6 after reboot                                 | **PASS** | `15`: attach settled the row (`native-epoch-ended / prior-boot`), phase `idle`, GC `2 removed`; `--resolve` then reports nothing unsettled; `16`: a new activation runs normally           |
| F7 assets with `_redirects` handling            | **PASS** | `logs/mobile-components-613.log`: unmodified dist packaged                                                                                                                                 |
| F8 causes                                       | **PASS** | `09`: `failed: route-unverified [MobileGatewayRouteUnverified]`; `10`: `failed: consent-revoked`                                                                                           |

`--resolve` clearing a row on demand is covered by unit tests. Live, the automatic attach path
settled the row first.

### What remains (user)

- Real Tailscale Serve plus a physical phone: authenticated `/mobile-ws` admission and the
  "ready again" half of 5a (F9).
- x86_64.

Evidence for this re-run: `/tmp/bigbud-mobile-fix-20261118T050343Z/` (logs/, live/, vm/, tools/;
no private key or tokens), archived as
`~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261118-mobile-inc7-fix.tar.zst` with a `.sha256`
file.

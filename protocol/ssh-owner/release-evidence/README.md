# S0 release evidence preflight

This offline helper records a fingerprint for **one explicitly supplied regular file** and a checklist for **one case** from the [S0 profile matrix](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-s0-profiles.md). It does not install, unpack, verify signatures, run the artifact, start an app, deploy, or connect. Use a local copy outside user profiles; keep trace locators and case metadata redacted. The tool reads no ambient SSH configuration or profile data.

From the repository root, using an already available local Bun installation:

```sh
bun run protocol/ssh-owner/release-evidence/preflight.ts \
  --artifact ./apps/server/dist/bin.mjs \
  --case-json '{"caseId":"F01-local-input","profile":"V-E","scenario":"checkout bundle fingerprint only","artifactId":"local server bundle","target":{"os":"darwin","arch":"arm64"}}' \
  --probe-local-ssh
```

That example fingerprints a development input, **not an Electron dev smoke**. Use `--probe-local-ssh` only on macOS when the case target matches the local OS/arch. It runs only the root-owned, non-group/world-writable regular `/usr/bin/ssh` with `-V`, a minimal environment, no shell, no stdin and a timeout. Its `osVersion` is the Darwin kernel release, not a macOS marketing version/build number, product runtime version, or ABI measurement.

On any platform, omit `--probe-local-ssh` and supply a measured `preflight` object in the case JSON instead. This never runs the reported SSH executable, even if the tool is run on a different machine. Use canonical OS/arch values (`darwin`, `linux`, `win32`; `arm64`, `x64` for the published artifact matrices) and a fully qualified SSH path from the measured machine. Example shape only; substitute actual measurements:

```json
{
  "caseId": "F02-inbox-login-password",
  "profile": "D",
  "scenario": "Win10 22H2 inbox OpenSSH login password",
  "artifactId": "release tag and installer filename",
  "target": { "os": "win32", "arch": "x64" },
  "preflight": {
    "os": "win32",
    "arch": "x64",
    "osVersion": "Windows 10 22H2 (include actual build)",
    "openSsh": {
      "image": "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      "version": "OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2"
    }
  }
}
```

Use `D`, `V-E`, `V-B`, `N`, or `R`. D/N/R target checks reflect the documented artifact matrices, not proof of support; development profiles do not have a frozen support list. Use a separate case per platform, role/route, auth flow, or other independent scenario as applicable. Include the [ledger](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-s0-ledger.md) fixture ID in `caseId` where useful. For release qualification, supply the actual installer, distribution archive, graph artifact, or exact development entry being evaluated. Use optional `expectedSha256` from an independently obtained manifest to compare bytes; the tool does not verify the manifest itself. Keep files stable while hashing.

The JSON output is always `status: "preflight-only"`. `missingTraceFields` lists absent references. Once authorized isolated runs exist, paste a `trace` object keyed by those exact names with nonempty redacted locators (for example, `isolated-run-17.json#process-tree`). The tool only checks presence and shape; it never opens the locators. A filled checklist is not a passed trace, and a case is not a profile-wide qualification. The preflight SSH version does not satisfy the **product-resolved** SSH trace field. Record legacy baselines and owner-only fields at their respective gates, and keep A/B rollback, legacy retirement, and per-operation acceptance in the plan and ledger. Successful preflight exits zero even with missing references; invalid input, read/probe failure, or digest mismatch exits nonzero without a report.

For structured observations beyond preflight, see the [offline A-to-B handoff boundary checker](forward/README.md) for verified A exits, writer-epoch takeover before B admission, and observed refusals at frozen legacy relaunch entries, and the [offline B-to-A rollback boundary checker](rollback/README.md) for retirement before A reopens the same DB. Neither report qualifies a release.

Focused tests from the repository root:

```sh
bun run vitest run --config protocol/ssh-owner/release-evidence/vitest.config.ts protocol/ssh-owner/release-evidence/preflight.test.ts
```

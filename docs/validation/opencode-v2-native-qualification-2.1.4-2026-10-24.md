# OpenCode V2 native qualification target 2.1.4 (2026-10-24)

The client is pinned to `@opencode/client` 2.1.4, so the native qualification target moves from 2.0.29 to 2.1.4. This record only covers that **retarget**. It is not an executed or promoted qualification: the release registry (`NativeCompatibility.qualification.registry.ts`) and the isolation approvals (`SharedService.native.isolation.approvals.ts`) stay empty until the two-pass `macos-arm64-qualification` job runs and its results are independently reviewed. The provenance method follows the [2.0.29 preparation ledger](opencode-v2-native-qualification-2.0.29-2026-10-15.md).

## Pinned values

| Field                                       | Value                                                                                                               | Provenance                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nativeVersion`                             | `2.1.4`                                                                                                             | Matches `OPENCODE_V2_CLIENT_VERSION`, so `assertDevelopmentVersion` no longer rejects the target (the 2.0.29 ledger's client/target mismatch is gone).                                        |
| `npmPackage` / `npmTarball`                 | `@opencode/cli-darwin-arm64` / `https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.1.4.tgz` | `npm view @opencode/cli-darwin-arm64@2.1.4 dist.tarball`                                                                                                                                      |
| `npmIntegrity`                              | `sha512-QwjyvovTdT0gFi5rxUyPVlYePIe3ELduR9olu+KJWe089XVIDOTMhxylBe/ZGIpvoXHYo6bp2NskIiqCFAEXsw==`                   | `npm view … dist.integrity`, and independently `openssl dgst -sha512 -binary` over the downloaded tarball (base64), which matched.                                                            |
| `executableSha256` (`package/bin/opencode`) | `d8a65dd253dbea759ae0dd829792ff219b40178c7decffea822430a4d1ccadb3`                                                  | Tarball downloaded to a disposable directory, verified against the integrity above, extracted with `tar -xzf`, then `shasum -a 256 package/bin/opencode` (214,407,424 bytes). Never executed. |
| `nativeSourceCommit` (tag `v2.1.4`)         | `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`                                                                          | `git ls-remote --tags https://github.com/anomalyco/opencode v2.1.4` (lightweight tag).                                                                                                        |
| `approvalId`                                | `gh-macos-15-arm64-opencode-2-1-4`                                                                                  | Same scheme as 2.0.29; matches the approval schema `^[a-z0-9-]{1,100}$`.                                                                                                                      |

The same values are pinned in `V2_NATIVE_QUALIFICATION_TARGET`, in `scripts/opencode-v2-fixture.ts` (`PINNED`) and in the workflow job. The provision pass re-derives the executable hash on the runner and refuses any drift.

## Provider status no longer depends on qualification

Missing release qualification is no longer shown to users. A shared service at or above the supported client version (2.1.4) reports green "ready". An older service reports amber with advice to run `opencode upgrade` and restart the service. Settings labels it "Update recommended". Runtime-checked thread-tools readiness reports success. Recorded incompatibilities and runtime bridge checks still block as before.

## Not done here

- No provisioning or qualification run, no approval record and no registry promotion.
- No independent review of qualification evidence. Promotion still needs the reviews described in the 2.0.29 ledger.

import type { CuaDriverReleaseArtifact, CuaDriverReleaseTable } from "./release.types.ts";

/**
 * Driver 0.38.0 release (lean upgrade M2). Selected only when the pin in
 * `release.ts` is flipped. Every platform uses the plain `-binary` archive
 * (bare executable at the archive root, `appPath: null`): no nested
 * `CuaDriver.app` with another team's provisioning profile is ever staged.
 * Hashes agree across `SHA256SUMS` (itself sha256 `a2c338d6…0645`),
 * `checksums.txt`, `release-manifest.json` and the release API digests
 * (recorded 2026-10-27; see the lean upgrade status doc).
 */
export const CUA_DRIVER_0_38_0_SOURCE = "85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19";

/**
 * Historical static evidence from approved probe A (darwin-arm64 archive,
 * which actually contains a universal executable). Its archive layout was not
 * recorded, so it is not an installable artifact yet. Never reuse these
 * hashes for another target.
 */
export const CUA_DRIVER_0_38_0_DARWIN_ARM64_EVIDENCE = Object.freeze({
  archiveName: "cua-driver-rs-0.38.0-darwin-arm64.tar.gz",
  archiveSha256: "5f71191c082ca07c9dfc13b7c9a6eec60a82818c245a93534cc0eb7911471d72",
  binarySha256: "92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f",
});

const binaryArtifact = (archiveName: string, sha256: string): CuaDriverReleaseArtifact => ({
  archiveName,
  sha256,
  binaryName: archiveName.endsWith(".zip") ? "cua-driver.exe" : "cua-driver",
  binaryPath: [archiveName.endsWith(".zip") ? "cua-driver.exe" : "cua-driver"],
  appPath: null,
});

/** One universal macOS archive serves both architectures. */
const macArtifact = binaryArtifact(
  "cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
  "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732",
);

export const CUA_DRIVER_0_38_0_ARTIFACTS: CuaDriverReleaseTable = Object.freeze({
  darwin: Object.freeze({ arm64: macArtifact, x64: macArtifact }),
  linux: Object.freeze({
    arm64: binaryArtifact(
      "cua-driver-rs-0.38.0-linux-arm64-binary.tar.gz",
      "80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d",
    ),
    x64: binaryArtifact(
      "cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz",
      "31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd",
    ),
  }),
  win32: Object.freeze({
    arm64: binaryArtifact(
      "cua-driver-rs-0.38.0-windows-arm64-binary.zip",
      "d25c8ebfffb34e4c095ea170baf47b87c35dc0d1116f42e46b39df2bcbff8700",
    ),
    x64: binaryArtifact(
      "cua-driver-rs-0.38.0-windows-x86_64-binary.zip",
      "5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5",
    ),
  }),
});

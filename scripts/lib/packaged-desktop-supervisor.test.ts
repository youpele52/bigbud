import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findPackagedDesktopSupervisor,
  getPackagedDesktopSupervisorSuffix,
  verifyPackagedDesktopSupervisorEvidence,
} from "./packaged-desktop-supervisor.ts";

describe("packaged desktop supervisor", () => {
  it("finds platform-native supervisor resources", () => {
    expect(getPackagedDesktopSupervisorSuffix("mac")).toContain("Contents/Resources");
    expect(getPackagedDesktopSupervisorSuffix("win").endsWith(".exe")).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "packaged-supervisor-"));
    try {
      const directory = join(root, "resources/server/delivery-supervisor/bin");
      mkdirSync(directory, { recursive: true });
      const binary = join(directory, "bigbud-desktop-supervisor");
      writeFileSync(binary, "fixture");
      expect(findPackagedDesktopSupervisor(root, "linux")).toBe(binary);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies the binary digest, protocol, and SBOM", () => {
    const root = mkdtempSync(join(tmpdir(), "packaged-supervisor-evidence-"));
    try {
      const binary = join(root, "bigbud-desktop-supervisor");
      writeFileSync(binary, "fixture");
      writeFileSync(
        join(root, "artifact-manifest.json"),
        JSON.stringify({
          binary: "bigbud-desktop-supervisor",
          protocol: { major: 1, minor: 1 },
          sha256: createHash("sha256").update("fixture").digest("hex"),
        }),
      );
      writeFileSync(
        join(root, "sbom.cdx.json"),
        JSON.stringify({ bomFormat: "CycloneDX", components: [] }),
      );
      expect(() => verifyPackagedDesktopSupervisorEvidence(binary)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { requiredLanes, slots, verificationModes, type Slot } from "./catalog.ts";

// Only synthetic shape/coverage fixtures; these represent no collected observations.
export function fixtures() {
  const cells = slots.map((slot, index) => {
    const supported =
      slot.disposition === "required" ||
      (slot.disposition === "review-scope" && slot.os === "darwin" && slot.arch === "arm64");
    const native = !!slot.inbox;
    const cell = `fixture-${index}`;
    const runtime = { D: "electron", "V-E": "electron", "V-B": "bun", N: "node", R: "node" }[
      slot.profile
    ];
    return {
      slot: slot.id,
      cell,
      disposition: supported ? "required" : "unsupported",
      identity: supported
        ? {
            a: { id: `${cell}-a`, build: "prep-build", sha256: "a".repeat(64) },
            b: { id: `${cell}-b`, build: "candidate-build", sha256: "b".repeat(64) },
            artifactVerification: verificationModes(slot)[0],
            dbDomain: `${cell}-db`,
            schemaA: 181,
            schemaB: 181,
            migration: 181,
            platform: {
              os: slot.os,
              arch: slot.arch,
              osBuild:
                slot.inbox === "win10-22h2"
                  ? "19045.1234"
                  : slot.inbox
                    ? "win11-26100.1234"
                    : "fixture-build",
              abi: slot.os === "linux" ? "gnu-fixture" : native ? "msvc-fixture" : "macho-fixture",
              runtimeBuild: `${runtime}-fixture`,
              sshOrigin: native ? "windows-inbox" : "system",
              sshVersion:
                slot.inbox === "win10-22h2"
                  ? "OpenSSH_for_Windows_8.1p1"
                  : native
                    ? "OpenSSH_for_Windows_9.5p1"
                    : "OpenSSH_9.9p1",
              sshSha256: "c".repeat(64),
            },
            owner: {
              image: { id: "owner", build: "owner-build", sha256: "d".repeat(64) },
              protocol: "v1",
            },
            askpass: native
              ? { id: "askpass", build: "askpass-build", sha256: "e".repeat(64) }
              : null,
          }
        : null,
    };
  });
  return {
    plan: { kind: "s4-matrix-plan-v1", scopeReview: "synthetic-scope-review", cells },
    bundle: {
      kind: "s4-matrix-claim-references-v1",
      scopeReview: "synthetic-scope-review",
      cells: cells.map((binding, index) => {
        const slot = slots[index] as Slot;
        const lanes = binding.identity
          ? requiredLanes(slot, !!binding.identity.askpass)
          : {
              "scope-exclusion":
                slot.disposition === "excluded"
                  ? "outside-artifact-matrix"
                  : "reviewed-unsupported-development",
            };
        return {
          binding: structuredClone(binding),
          claims: Object.entries(lanes).map(([lane, result]) => ({
            lane,
            result,
            status: "verified",
            ref: `${binding.cell}-${lane}`,
            decision:
              result === "reviewed-unsupported-development"
                ? "synthetic-decision"
                : (null as string | null),
          })),
        };
      }),
    },
  };
}

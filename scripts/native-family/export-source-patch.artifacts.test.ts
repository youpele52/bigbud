import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  assertNativeFamilyModuleInventory,
  NATIVE_FAMILY_BASELINE,
  NATIVE_FAMILY_MODULES,
  normalizeNativeFamilySourceBanners,
  verifyNativeFamilyArtifacts,
} from "./export-source-patch.artifacts.ts";

it.each([
  "/Users/developer/checkout/packages/core/src/session/family.ledger.ts",
  "../../../../private/var/folders/example/native-checkout/packages/core/src/session/family.ledger.ts",
  "C:\\Users\\developer\\native checkout\\packages\\core\\src\\session\\family.ledger.ts",
  "..\\..\\native-checkout\\packages\\core\\src\\session\\family.ledger.ts",
  "\\\\server\\share\\checkout\\packages\\core\\src\\session\\family.ledger.ts",
  "packages/core/src/session/family.ledger.ts",
])("normalizes a Bun source banner portably and idempotently: %s", (filename) => {
  const source = `import { helper } from "./receipt-shared.mjs";\n\n// ${filename}\nvar exports_family_ledger = {};\n`;
  const normalized = source.replace(
    `// ${filename}`,
    "// packages/core/src/session/family.ledger.ts",
  );
  expect(normalizeNativeFamilySourceBanners(source)).toBe(normalized);
  expect(normalizeNativeFamilySourceBanners(normalized)).toBe(normalized);
});

it("normalizes receipt namespaces and multiple banners without changing CRLF or other bytes", () => {
  const source =
    "// /private/var/native/packages/core/src/session/family.receipt.ts\r\nvar exports_family_receipt = {};\r\n\r\n// /Users/me/native/packages/core/src/session/family.ledger.ts\r\nvar exports_family_ledger = {};\r\n";
  expect(normalizeNativeFamilySourceBanners(source)).toBe(
    "// packages/core/src/session/family.receipt.ts\r\nvar exports_family_receipt = {};\r\n\r\n// packages/core/src/session/family.ledger.ts\r\nvar exports_family_ledger = {};\r\n",
  );
});

it("leaves meaningful comments, ordinary code strings and template contents byte-identical", () => {
  const filename = "/private/var/native/packages/core/src/session/family.ledger.ts";
  const source = [
    `// Source lives at ${filename}`,
    "var exports_family_ledger = {};",
    `const ordinary = "// ${filename}";`,
    "const example = `",
    `// ${filename}`,
    "var exports_family_ledger = {};",
    "`;",
    `/* // ${filename} */`,
    "var exports_family_ledger = {};",
    `// ${filename}`,
    "var another_namespace = {};",
    `// ${filename}`,
    "const exports_family_ledger = {};",
    `// ${filename}`,
    "var exports_family_receipt = {};",
    `// ${filename}`,
    "var exports_family_ledger = { meaningful: true };",
  ].join("\n");
  expect(normalizeNativeFamilySourceBanners(source)).toBe(source);
});

const patch = "unchanged source patch\n";
const modules = {
  "ledger.mjs": "// source ledger\n",
  "receipt-shared.mjs": "// source receipt\n",
  "family.receipt.mjs": "// source entry\n",
};
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const manifest = {
  abi: "opencode.native-family.v1",
  baseline: NATIVE_FAMILY_BASELINE,
  sourceDigest: "a".repeat(64),
  patchSha256: sha256(patch),
  ledgerSha256: sha256(modules["ledger.mjs"]),
  modules: Object.fromEntries(
    Object.entries(modules).map(([name, content]) => [name, sha256(content)]),
  ),
  evidenceKind: "source-unit-only",
  nativeQualification: false,
};

it("accepts only the exact verified source-unit inventory without changing identity claims", () => {
  expect(verifyNativeFamilyArtifacts(manifest, modules, patch)).toEqual(manifest);
  expect(() =>
    assertNativeFamilyModuleInventory([...NATIVE_FAMILY_MODULES].toReversed()),
  ).not.toThrow();
});

it.each([
  { names: ["ledger.mjs", "receipt-shared.mjs"] },
  { names: [...NATIVE_FAMILY_MODULES, "unexpected.mjs"] },
  { names: [...NATIVE_FAMILY_MODULES, "ledger.mjs"] },
])("rejects missing/extra/duplicate generated modules: %j", ({ names }) => {
  expect(() => assertNativeFamilyModuleInventory(names)).toThrow("inventory mismatch");
});

it("rejects pre-existing module/patch hash corruption before normalization can bless it", () => {
  expect(() =>
    verifyNativeFamilyArtifacts(manifest, { ...modules, "ledger.mjs": "tampered" }, patch),
  ).toThrow("module hash mismatch");
  expect(() => verifyNativeFamilyArtifacts(manifest, modules, "changed patch")).toThrow(
    "source patch hash mismatch",
  );
  expect(() =>
    verifyNativeFamilyArtifacts({ ...manifest, ledgerSha256: "b".repeat(64) }, modules, patch),
  ).toThrow("ledger/source patch hash mismatch");
});

it.each([
  { nativeQualification: true },
  { evidenceKind: "runtime-qualified" },
  { baseline: "0".repeat(40) },
  { modules: { ...manifest.modules, "extra.mjs": "b".repeat(64) } },
])("rejects unexpected qualification, baseline or manifest inventory: %j", (changed) => {
  expect(() => verifyNativeFamilyArtifacts({ ...manifest, ...changed }, modules, patch)).toThrow();
});

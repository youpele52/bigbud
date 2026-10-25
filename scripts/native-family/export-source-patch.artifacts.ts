import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as Schema from "effect/Schema";
import {
  createSourceFile,
  getLeadingCommentRanges,
  isIdentifier,
  isObjectLiteralExpression,
  isVariableStatement,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
} from "typescript";

export const NATIVE_FAMILY_BASELINE = "9b4ec5714d481559990db0a816d5dec19541a814";
export const NATIVE_FAMILY_MODULES = [
  "ledger.mjs",
  "receipt-shared.mjs",
  "family.receipt.mjs",
] as const;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Manifest = Schema.Struct({
  abi: Schema.Literal("opencode.native-family.v1"),
  baseline: Schema.Literal(NATIVE_FAMILY_BASELINE),
  sourceDigest: Digest,
  patchSha256: Digest,
  ledgerSha256: Digest,
  modules: Schema.Struct({
    "ledger.mjs": Digest,
    "receipt-shared.mjs": Digest,
    "family.receipt.mjs": Digest,
  }),
  evidenceKind: Schema.Literal("source-unit-only"),
  nativeQualification: Schema.Literal(false),
});
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

/** Normalize only real top-level Bun namespace banners, never strings/template
 * contents or prose comments that happen to mention a source path. */
export function normalizeNativeFamilySourceBanners(content: string): string {
  const parsed = createSourceFile(
    "native-family.mjs",
    content,
    ScriptTarget.Latest,
    false,
    ScriptKind.JS,
  );
  const edits: { start: number; end: number; text: string }[] = [];
  for (const statement of parsed.statements) {
    if (!isVariableStatement(statement) || statement.declarationList.flags & NodeFlags.BlockScoped)
      continue;
    const declarations = statement.declarationList.declarations;
    if (declarations.length !== 1) continue;
    const declaration = declarations[0]!;
    if (
      !isIdentifier(declaration.name) ||
      !declaration.initializer ||
      !isObjectLiteralExpression(declaration.initializer) ||
      declaration.initializer.properties.length
    )
      continue;
    const module = declaration.name.text.match(/^exports_family_(ledger|receipt)$/)?.[1];
    if (!module) continue;
    for (const comment of getLeadingCommentRanges(content, statement.pos) ?? []) {
      if (
        comment.kind !== SyntaxKind.SingleLineCommentTrivia ||
        (comment.pos > 0 && content[comment.pos - 1] !== "\n")
      )
        continue;
      const banner = content
        .slice(comment.pos, comment.end)
        .replaceAll("\\", "/")
        .match(
          /^\/\/ ((?:(?:\/|[A-Za-z]:\/|\.\.?\/).*\/)?packages\/core\/src\/session\/family\.(ledger|receipt)\.ts)$/,
        );
      if (banner?.[2] !== module) continue;
      edits.push({
        start: comment.pos,
        end: comment.end,
        text: `// packages/core/src/session/family.${module}.ts`,
      });
    }
  }
  for (const edit of edits.toReversed())
    content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  return content;
}

/** Reject missing, extra or duplicate outputs before touching generated files. */
export function assertNativeFamilyModuleInventory(names: readonly string[]) {
  if (names.toSorted().join("\n") !== NATIVE_FAMILY_MODULES.toSorted().join("\n"))
    throw new Error("Native family module inventory mismatch.");
}

/** Verify the committed source-only evidence before a repo-only transformation. */
export function verifyNativeFamilyArtifacts(
  input: unknown,
  modules: Readonly<Record<string, string>>,
  patch: string,
) {
  const manifest = Schema.decodeUnknownSync(Manifest)(input, { onExcessProperty: "error" });
  assertNativeFamilyModuleInventory(Object.keys(modules));
  for (const name of NATIVE_FAMILY_MODULES)
    if (sha256(modules[name]!) !== manifest.modules[name])
      throw new Error(`Native family module hash mismatch: ${name}`);
  if (
    manifest.ledgerSha256 !== manifest.modules["ledger.mjs"] ||
    sha256(patch) !== manifest.patchSha256
  )
    throw new Error("Native family ledger/source patch hash mismatch.");
  return manifest;
}

/** Shared generator output boundary: normalize, format and hash the exact bytes. */
export async function writeNativeFamilyModule(project: string, name: string, content: string) {
  if (!NATIVE_FAMILY_MODULES.some((expected) => expected === name))
    throw new Error(`Unexpected native family output: ${name}`);
  const filename = path.join(project, "patches/opencode-native-family-v1", name);
  await writeFile(filename, normalizeNativeFamilySourceBanners(content));
  execFileSync(path.join(project, "node_modules/.bin/oxfmt"), [filename]);
  const formatted = await readFile(filename, "utf8");
  if (formatted.trimEnd().split("\n").length > 400)
    throw new Error(`Split generated source at its native module boundary: ${name}`);
  return sha256(formatted);
}

/** Repo-only hygiene, not a native source export/build or new qualification. */
export async function normalizeNativeFamilyArtifacts(project: string) {
  const output = path.join(project, "patches/opencode-native-family-v1");
  const expected = [...NATIVE_FAMILY_MODULES, "README.md", "manifest.json"].toSorted();
  if (
    (await lstat(output)).isSymbolicLink() ||
    (await readdir(output)).toSorted().join("\n") !== expected.join("\n")
  )
    throw new Error("Native family artifact directory inventory mismatch.");
  const patchFile = path.join(project, "patches/opencode@2.0.26-native-family-v1.patch");
  for (const filename of [...expected.map((name) => path.join(output, name)), patchFile]) {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Expected regular artifact: ${filename}`);
  }
  const content = Object.fromEntries(
    await Promise.all(
      NATIVE_FAMILY_MODULES.map(
        async (name) => [name, await readFile(path.join(output, name), "utf8")] as const,
      ),
    ),
  );
  const manifest = verifyNativeFamilyArtifacts(
    JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")),
    content,
    await readFile(patchFile, "utf8"),
  );
  const modules = { ...manifest.modules };
  const changed: string[] = [];
  for (const name of NATIVE_FAMILY_MODULES) {
    if (normalizeNativeFamilySourceBanners(content[name]!) === content[name]) continue;
    modules[name] = await writeNativeFamilyModule(project, name, content[name]!);
    changed.push(name);
  }
  if (changed.length)
    await writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify({ ...manifest, ledgerSha256: modules["ledger.mjs"], modules }, null, 2) + "\n",
    );
  return changed;
}

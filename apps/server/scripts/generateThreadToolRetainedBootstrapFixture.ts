import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Offline, pinned PREVIOUS-current source, not a native qualification or a live artifact capture.
const commit = "c015538b2ad999a1a76fb62186b8d8a3c540d9f8";
const server = fileURLToPath(new URL("../", import.meta.url));
const prefix = "apps/server/src/provider/Layers/OpencodeV2/";
const temporary = await mkdtemp(path.join(server, ".retained-bootstrap-"));
const sources = new Map<string, string>();
async function copy(name: string): Promise<void> {
  if (sources.has(name)) return;
  const source = execFileSync("git", ["show", `${commit}:${name}`], {
    cwd: server,
    encoding: "utf8",
  });
  sources.set(name, createHash("sha256").update(source).digest("hex"));
  await mkdir(path.dirname(path.join(temporary, name)), { recursive: true });
  await writeFile(path.join(temporary, name), source);
  for (const match of source.matchAll(/(?:from\s*|import\s*\()"(\.{1,2}\/[^"\n]+\.ts)"/g))
    await copy(path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]!)));
}
try {
  for (const name of ["Orchestration.artifact.ts", "Orchestration.compatibility.ts"])
    await copy(prefix + name);
  const load = (name: string) => import(pathToFileURL(path.join(temporary, prefix, name)).href);
  const compatibility = await load("Orchestration.compatibility.ts");
  if (
    compatibility.V2_COMPATIBILITY_DIGEST !==
    "d992b9c514082e59f91d877d954048e62a4a5025836b295097cdb64719d7b7db"
  )
    throw new Error("Pinned previous-current descriptor changed.");
  // Derive these bytes/digests from the pinned source tree, not supplied live hashes.
  const records: unknown[] = [
    {
      kind: "provenance",
      commit,
      sources: [...sources].toSorted(([a], [b]) => a.localeCompare(b)),
    },
    {
      kind: "compatibility",
      descriptor: compatibility.V2_BOOTSTRAP_COMPATIBILITY,
      digest: compatibility.V2_COMPATIBILITY_DIGEST,
    },
  ];
  // Export with fresh disposable keys, then replace only their literal encodings in the fixture.
  const { exportV2ThreadArtifact } = await load("Orchestration.artifact.ts");
  await mkdir(path.join(temporary, "state"), { mode: 0o700 });
  const artifact = await exportV2ThreadArtifact(path.join(temporary, "state"));
  await artifact.verify();
  const manifest = JSON.parse(
    await readFile(path.join(artifact.directory, "manifest.json"), "utf8"),
  );
  for (const [name] of manifest.hashes as [string, string][]) {
    const content = (await readFile(path.join(artifact.directory, name), "utf8"))
      .replaceAll(JSON.stringify(artifact.publicKey), JSON.stringify("FIXTURE_PUBLIC_KEY"))
      .replaceAll(
        JSON.stringify(artifact.encryptionPublicKey),
        JSON.stringify("FIXTURE_ENCRYPTION_KEY"),
      );
    if (content.split("\n").length > 401)
      throw new Error("Pinned previous bootstrap module exceeds 400 lines.");
    records.push({ kind: "module", name, content });
  }
  const result = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const output = path.join(
    server,
    prefix.replace("apps/server/", ""),
    "Orchestration.bootstrap.previous.ndjson",
  );
  if (process.argv.includes("--check")) {
    if ((await readFile(output, "utf8")) !== result)
      throw new Error("Pinned bootstrap fixture changed.");
  } else await writeFile(output, result);
  console.log(JSON.stringify(records[1]));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

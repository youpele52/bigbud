import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const HANDOFF_TMP_DIR = path.join(homedir(), ".bigbud", "skills", "handoff", "tmp");

function slugifyHandoffTitle(value: string | undefined): string {
  const base = (value ?? "handoff")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base.length > 0 ? base : "handoff";
}

export async function writeHandoffDocumentFile(input: {
  readonly title?: string | undefined;
  readonly content: string;
}): Promise<string> {
  await mkdir(HANDOFF_TMP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const suffix = crypto.randomUUID().slice(0, 8);
  const fileName = `${stamp}-${slugifyHandoffTitle(input.title)}-${suffix}.md`;
  const filePath = path.join(HANDOFF_TMP_DIR, fileName);
  await writeFile(filePath, `${input.content.trim()}\n`, "utf8");
  return filePath;
}

import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  renderThirdPartyNotices,
  type GraphNoticeEntry,
} from "./build-remote-backend-graph.notices.ts";

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const files: Record<string, Buffer> = {
  "node_modules/a/LICENSE": Buffer.from("MIT a\r\nline two\n\n"),
  "notices/bundled/b@2.0.0/NOTICE.bin": Buffer.from([0x4e, 0, 0x4f]),
};
const entries: GraphNoticeEntry[] = [
  {
    kind: "package",
    name: "a",
    version: "1.0.0",
    license: "MIT",
    directory: "node_modules/a",
    files: [{ path: "node_modules/a/LICENSE", sha256: sha256(files["node_modules/a/LICENSE"]!) }],
  },
  {
    kind: "bundled",
    name: "b",
    version: "2.0.0",
    license: "SEE LICENSE IN README.md",
    directory: "",
    files: [
      {
        path: "notices/bundled/b@2.0.0/NOTICE.bin",
        sha256: sha256(files["notices/bundled/b@2.0.0/NOTICE.bin"]!),
      },
    ],
  },
  { kind: "package", name: "c", version: "3.0.0", license: null, directory: "x", files: [] },
];
const read = async (path: string) => files[path]!;

it("third_party_notices_aggregates_every_entry_verbatim", async () => {
  const text = await renderThirdPartyNotices("Title", entries, read);
  expect(text.startsWith("Title\n")).toBe(true);
  expect(text).toContain(
    "a@1.0.0 (package)\nDeclared license: MIT\nLocation: node_modules/a\n" +
      `\n--- node_modules/a/LICENSE (sha256 ${entries[0]!.files[0]!.sha256}) ---\n\nMIT a\nline two\n`,
  );
  expect(text).toContain("Declared license: SEE LICENSE IN README.md");
  expect(text).toContain("Location: inlined into the server bundle");
  expect(text).toContain("[binary file, 3 bytes]");
  expect(text).toContain(
    "c@3.0.0 (package)\nDeclared license: none declared\nLocation: x\n\n" +
      "No license or notice file is shipped for this component.",
  );
  expect(await renderThirdPartyNotices("Title", entries, read)).toBe(text);
});

it("third_party_notices_refuses_a_changed_file", async () => {
  await expect(
    renderThirdPartyNotices("Title", entries, async (path) =>
      path.endsWith("LICENSE") ? Buffer.from("changed") : files[path]!,
    ),
  ).rejects.toThrow("Notice file node_modules/a/LICENSE changed after it was inventoried.");
});

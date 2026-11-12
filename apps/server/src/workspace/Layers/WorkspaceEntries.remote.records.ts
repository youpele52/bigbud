/** Parse only the metadata separator: tabs after it belong to the filename. */
export function parseRemoteFindRecord(record: string): {
  path: string;
  kind: "file" | "directory";
} | null {
  if (record[1] !== "\t" || (record[0] !== "d" && record[0] !== "f")) return null;
  const path = record.slice(2).replace(/^\.\//, "");
  if (!path || path === "." || path.includes("\0")) return null;
  return { path, kind: record[0] === "d" ? "directory" : "file" };
}

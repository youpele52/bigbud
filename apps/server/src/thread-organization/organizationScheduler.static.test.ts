import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const production = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return production(path);
    return /\.tsx?$/.test(entry.name) &&
      !/\.(test|fixture|browser)\.tsx?$|\.test\.helpers\.ts$/.test(entry.name)
      ? [path]
      : [];
  });

it("Rust is the sole production scheduler: no production module uses the legacy TS schedulers", () => {
  const offenders: string[] = [];
  for (const file of production(root)) {
    const source = readFileSync(file, "utf8");
    const name = relative(root, file);
    if (/ThreadOrganizationReactor\.(idle|snooze)(\.logic)?\.fixture/.test(source))
      offenders.push(`${name}: imports a legacy scheduler fixture`);
    // Only the decider may name these commands; producing them would be a second scheduler.
    if (
      /type:\s*"thread\.organization\.(idle|snooze\.expire)"/.test(source) &&
      !name.startsWith("orchestration/decider")
    )
      offenders.push(`${name}: produces a legacy scheduling command`);
  }
  expect(offenders).toEqual([]);
});
